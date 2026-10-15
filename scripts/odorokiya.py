#!/usr/bin/env python3
"""驚き屋スタジオ(odorokiya-studio)の補助スクリプト。X API v2 に OAuth 1.0a (user context) で投稿する。

認証情報は次の順で探す。
  1. 環境変数 ODOROKIYA_X_API_KEY / ODOROKIYA_X_API_SECRET /
     ODOROKIYA_X_ACCESS_TOKEN / ODOROKIYA_X_ACCESS_TOKEN_SECRET
     (Mod が userConfig の sensitive 項目から渡す)
  2. macOS キーチェーン service=odorokiya-studio(旧名 x-post も読む)の account
     consumer_key / consumer_secret / access_token / access_token_secret
送信先は https://api.x.com だけ。

使い方:
  odorokiya.py check                       -> {"ok": true, "username": "..."}
  odorokiya.py save-keys < JSON            -> 標準入力の 4 つの鍵をキーチェーンに保存して check と同じ結果
                                              (鍵はコマンドライン引数に載せない)
  odorokiya.py post --text T [--media P]...  -> {"ok": true, "id": "...", "url": "..."}
  odorokiya.py thumb PATH [--size N]       -> {"ok": true, "b64": "<jpeg>", "w": W, "h": H, "duration": 秒|null}
結果は常に JSON 1 行を stdout に出す。標準ライブラリのみ。
"""
import argparse
import base64
import hashlib
import hmac
import json
import mimetypes
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.x.com"
SERVICES = ("odorokiya-studio", "x-post")
ENV_NAMES = {
    "consumer_key": "ODOROKIYA_X_API_KEY",
    "consumer_secret": "ODOROKIYA_X_API_SECRET",
    "access_token": "ODOROKIYA_X_ACCESS_TOKEN",
    "access_token_secret": "ODOROKIYA_X_ACCESS_TOKEN_SECRET",
}
CHUNK = 4 * 1024 * 1024
KEYS = ("consumer_key", "consumer_secret", "access_token", "access_token_secret")
VIDEO_TYPES = {"video/mp4", "video/quicktime", "video/webm"}


class Fail(Exception):
    def __init__(self, message, code="error"):
        super().__init__(message)
        self.code = code


# X API のエラーを、原因と直し方の言葉にする
def explain(status, detail):
    low = detail.lower()
    if status == 401:
        return "auth", "鍵が正しくありません。4 つの値を確認してください(API Key と Access Token の取り違え、前後の空白、再発行前の古い値が多い原因です)"
    if status == 403 and ("oauth1-permissions" in low or "not permitted" in low or "permission" in low or "write" in low):
        return "readonly", "トークンが読み取り専用です。アプリの App permissions を Read and write にしたあと、Access Token と Secret を再発行して入れ直してください"
    if status == 402 or "credit" in low or "payment" in low:
        return "credits", "X API のクレジットが足りません。X Developer Console の Billing を確認してください"
    if status == 429:
        return "ratelimit", "X API の回数制限に当たりました。少し時間をおいてから試してください"
    if status == 403:
        return "forbidden", "X に断られました(403)。アプリの権限とアカウントの状態を確認してください"
    return "api", f"X API のエラー(HTTP {status})"


def keychain(service, account):
    if not os.path.exists("/usr/bin/security"):
        return None
    r = subprocess.run(
        ["/usr/bin/security", "find-generic-password", "-s", service, "-a", account, "-w"],
        capture_output=True, text=True,
    )
    return r.stdout.strip() if r.returncode == 0 and r.stdout.strip() else None


def creds():
    from_env = {k: os.environ.get(v, "").strip() for k, v in ENV_NAMES.items()}
    if all(from_env.values()):
        return from_env
    for service in SERVICES:
        found = {k: keychain(service, k) for k in KEYS}
        if all(found.values()):
            return found
    raise Fail("X の鍵がまだありません。パネルの「X とつなぐ」から登録してください", "nokeys")


def q(s):
    return urllib.parse.quote(str(s), safe="~-._")


def oauth_header(c, method, url, query):
    # JSON / multipart のボディは署名対象外。クエリだけ含める。
    params = {
        "oauth_consumer_key": c["consumer_key"],
        "oauth_nonce": secrets.token_hex(16),
        "oauth_signature_method": "HMAC-SHA1",
        "oauth_timestamp": str(int(time.time())),
        "oauth_token": c["access_token"],
        "oauth_version": "1.0",
    }
    allp = {**params, **query}
    base_params = "&".join(f"{q(k)}={q(v)}" for k, v in sorted(allp.items()))
    base = "&".join([method.upper(), q(url), q(base_params)])
    key = f"{q(c['consumer_secret'])}&{q(c['access_token_secret'])}"
    sig = base64.b64encode(hmac.new(key.encode(), base.encode(), hashlib.sha1).digest()).decode()
    params["oauth_signature"] = sig
    return "OAuth " + ", ".join(f'{q(k)}="{q(v)}"' for k, v in sorted(params.items()))


def call(c, method, path, query=None, body=None, content_type=None):
    query = query or {}
    url = API + path
    full = url + ("?" + urllib.parse.urlencode(query) if query else "")
    req = urllib.request.Request(full, data=body, method=method)
    req.add_header("Authorization", oauth_header(c, method, url, query))
    if content_type:
        req.add_header("Content-Type", content_type)
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            raw = res.read()
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", "replace")[:500]
        code, message = explain(err.code, detail)
        raise Fail(f"{message} [{method} {path} -> HTTP {err.code}: {detail[:200]}]", code)
    except urllib.error.URLError as err:
        raise Fail(f"api.x.com に接続できません: {err.reason}", "network")
    return json.loads(raw) if raw else {}


def multipart(fields, file_field, filename, data):
    boundary = "----odorokiya" + secrets.token_hex(12)
    parts = []
    for k, v in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; filename="{filename}"\r\n'
        f"Content-Type: application/octet-stream\r\n\r\n".encode()
    )
    parts.append(data)
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def category(mime):
    if mime in VIDEO_TYPES:
        return "tweet_video"
    if mime == "image/gif":
        return "tweet_gif"
    return "tweet_image"


def upload(c, path):
    mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
    if mime == "video/x-m4v":
        mime = "video/mp4"
    size = os.path.getsize(path)
    init = call(c, "POST", "/2/media/upload/initialize",
                body=json.dumps({"media_type": mime, "total_bytes": size, "media_category": category(mime)}).encode(),
                content_type="application/json")
    media_id = init["data"]["id"]
    with open(path, "rb") as f:
        index = 0
        while True:
            chunk = f.read(CHUNK)
            if not chunk:
                break
            body, ctype = multipart({"segment_index": index}, "media", os.path.basename(path), chunk)
            call(c, "POST", f"/2/media/upload/{media_id}/append", body=body, content_type=ctype)
            index += 1
    fin = call(c, "POST", f"/2/media/upload/{media_id}/finalize")
    info = (fin.get("data") or fin).get("processing_info")
    deadline = time.time() + 480
    while info and info.get("state") in ("pending", "in_progress"):
        if time.time() > deadline:
            raise Fail(f"{os.path.basename(path)} の処理がタイムアウトしました")
        time.sleep(max(1, int(info.get("check_after_secs", 2))))
        st = call(c, "GET", "/2/media/upload", query={"command": "STATUS", "media_id": media_id})
        info = (st.get("data") or st).get("processing_info")
    if info and info.get("state") == "failed":
        raise Fail(f"{os.path.basename(path)} の処理に失敗: {json.dumps(info, ensure_ascii=False)}")
    return media_id


KEY_SHAPE = __import__("re").compile(r"^[A-Za-z0-9\-_=+/.%]{10,200}$")


def cmd_save_keys(_args):
    if not os.path.exists("/usr/bin/security"):
        raise Fail("キーチェーンが使えない環境です。プラグインの設定画面で 4 つの鍵を入れてください", "nokeychain")
    try:
        given = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        raise Fail("鍵の受け取りに失敗しました", "input")
    values = {k: str(given.get(k, "")).strip() for k in KEYS}
    labels = {"consumer_key": "API Key", "consumer_secret": "API Secret",
              "access_token": "Access Token", "access_token_secret": "Access Token Secret"}
    for k, v in values.items():
        if not v:
            raise Fail(f"{labels[k]} が空です", "input")
        if not KEY_SHAPE.match(v):
            raise Fail(f"{labels[k]} に使えない文字が入っています。コピーし直して貼り付けてください", "input")
    if values["consumer_key"] == values["access_token"]:
        raise Fail("API Key と Access Token に同じ値が入っています", "input")
    # 「読むたびに確認」のときは、信頼するアプリを空(-T "")にして作り直す。
    # 既存の項目は ACL を引き継ぐので、いったん消してから作る
    confirm = os.environ.get("ODOROKIYA_KEYCHAIN_CONFIRM") == "1"
    if confirm:
        for k in KEYS:
            subprocess.run(["/usr/bin/security", "delete-generic-password", "-s", SERVICES[0], "-a", k],
                           capture_output=True, timeout=20)
    trust = ' -T ""' if confirm else ""
    # security -i は標準入力からコマンドを読むので、鍵がプロセスの引数一覧に出ない
    script = "".join(
        f'add-generic-password -U -s "{SERVICES[0]}" -a "{k}"{trust} -w "{v}"\n' for k, v in values.items()
    )
    r = subprocess.run(["/usr/bin/security", "-i"], input=script, capture_output=True, text=True, timeout=20)
    if r.returncode != 0:
        raise Fail("キーチェーンへの保存に失敗しました", "keychain")
    return cmd_check(_args)


def cmd_check(_args):
    c = creds()
    me = call(c, "GET", "/2/users/me")
    return {"ok": True, "username": me["data"]["username"]}


def cmd_post(args):
    c = creds()
    media = args.media or []
    for p in media:
        if not os.path.isfile(p):
            raise Fail(f"ファイルがありません: {p}")
    ids = [upload(c, p) for p in media]
    payload = {"text": args.text}
    if ids:
        payload["media"] = {"media_ids": ids}
    res = call(c, "POST", "/2/tweets", body=json.dumps(payload).encode(), content_type="application/json")
    tid = res["data"]["id"]
    user = ""
    try:
        user = call(c, "GET", "/2/users/me")["data"]["username"]
    except Fail:
        pass
    url = f"https://x.com/{user or 'i'}/status/{tid}"
    return {"ok": True, "id": tid, "url": url}


def run_quiet(argv):
    return subprocess.run(argv, capture_output=True, text=True, timeout=20)


def jpeg_size(data):
    # JPEG の SOF から幅と高さを読む
    i = 2
    while i < len(data) - 9:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xC0, 0xC1, 0xC2):
            return int.from_bytes(data[i + 7:i + 9], "big"), int.from_bytes(data[i + 5:i + 7], "big")
        i += 2 + int.from_bytes(data[i + 2:i + 4], "big")
    return 0, 0


def video_duration(path):
    probe = shutil.which("ffprobe") or next((p for p in ("/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe") if os.path.exists(p)), None)
    if probe:
        r = run_quiet([probe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path])
        try:
            return round(float(r.stdout.strip()))
        except ValueError:
            pass
    md = run_quiet(["/usr/bin/mdls", "-raw", "-name", "kMDItemDurationSeconds", path]).stdout.strip()
    try:
        return round(float(md))
    except ValueError:
        return None


def cmd_thumb(args):
    path = args.path
    if not os.path.isfile(path):
        raise Fail(f"ファイルがありません: {path}")
    mime = mimetypes.guess_type(path)[0] or ""
    work = tempfile.mkdtemp(prefix="odorokiya-thumb-")
    try:
        src = path
        duration = None
        if mime.startswith("video/"):
            # Quick Look で先頭付近のフレームを PNG にする
            run_quiet(["/usr/bin/qlmanage", "-t", "-s", str(args.size * 2), "-o", work, path])
            pngs = [f for f in os.listdir(work) if f.endswith(".png")]
            if not pngs:
                raise Fail("動画のサムネイルを作れませんでした")
            src = os.path.join(work, pngs[0])
            duration = video_duration(path)
        out = os.path.join(work, "thumb.jpg")
        r = run_quiet(["/usr/bin/sips", "-s", "format", "jpeg", "-s", "formatOptions", "62",
                       "-Z", str(args.size), src, "--out", out])
        if r.returncode != 0 or not os.path.isfile(out):
            raise Fail("サムネイルの変換に失敗しました")
        data = open(out, "rb").read()
        w, h = jpeg_size(data)
        return {"ok": True, "b64": base64.b64encode(data).decode(), "w": w, "h": h, "duration": duration}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check")
    sub.add_parser("save-keys")
    p = sub.add_parser("post")
    p.add_argument("--text", required=True)
    p.add_argument("--media", action="append")
    t = sub.add_parser("thumb")
    t.add_argument("path")
    t.add_argument("--size", type=int, default=200)
    args = ap.parse_args()
    try:
        out = {"check": cmd_check, "save-keys": cmd_save_keys, "post": cmd_post, "thumb": cmd_thumb}[args.cmd](args)
    except Fail as err:
        out = {"ok": False, "error": str(err), "code": err.code}
    except Exception as err:  # noqa: BLE001
        out = {"ok": False, "error": f"{type(err).__name__}: {err}"}
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0 if out["ok"] else 1)


if __name__ == "__main__":
    main()
