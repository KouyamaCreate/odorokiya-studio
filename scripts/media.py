#!/usr/bin/env python3
"""驚き屋スタジオ(odorokiya-studio)のサムネイル作成スクリプト。

ネットワークは使わない。macOS に入っている次のプログラムだけを、決まった引数で動かす。
  /usr/bin/sips      画像を JPEG のサムネイルに縮める
  /usr/bin/qlmanage  動画の 1 コマを PNG にする(Quick Look)
作業用の一時フォルダは作成後すぐ消す。動画の長さはファイルの mvhd を読んで求める。

使い方:
  media.py thumb PATH [--size N]  -> {"ok": true, "b64": "<jpeg>", "w": W, "h": H, "duration": 秒|null}
結果は常に JSON 1 行を stdout に出す。標準ライブラリのみ。
"""
import argparse
import base64
import json
import mimetypes
import os
import shutil
import struct
import subprocess
import sys
import tempfile

SIPS = "/usr/bin/sips"
QLMANAGE = "/usr/bin/qlmanage"


class Fail(Exception):
    pass


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
    # mp4 / mov の moov > mvhd から長さ(秒)を読む。読めなければ None
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError:
        return None

    def boxes(buf, start, end):
        i = start
        while i + 8 <= end:
            size, kind = struct.unpack(">I4s", buf[i:i + 8])
            header = 8
            if size == 1 and i + 16 <= end:
                size = struct.unpack(">Q", buf[i + 8:i + 16])[0]
                header = 16
            elif size == 0:
                size = end - i
            if size < header:
                return
            yield kind, i + header, i + size
            i += size

    for kind, s, e in boxes(data, 0, len(data)):
        if kind != b"moov":
            continue
        for k2, s2, _e2 in boxes(data, s, e):
            if k2 != b"mvhd":
                continue
            version = data[s2]
            if version == 1:
                timescale, duration = struct.unpack(">IQ", data[s2 + 20:s2 + 32])
            else:
                timescale, duration = struct.unpack(">II", data[s2 + 12:s2 + 20])
            return round(duration / timescale) if timescale else None
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
            run_quiet([QLMANAGE, "-t", "-s", str(args.size * 2), "-o", work, path])
            pngs = [f for f in os.listdir(work) if f.endswith(".png")]
            if not pngs:
                raise Fail("動画のサムネイルを作れませんでした")
            src = os.path.join(work, pngs[0])
            duration = video_duration(path)
        out = os.path.join(work, "thumb.jpg")
        r = run_quiet([SIPS, "-s", "format", "jpeg", "-s", "formatOptions", "62", "-Z", str(args.size), src, "--out", out])
        if r.returncode != 0 or not os.path.isfile(out):
            raise Fail("サムネイルの変換に失敗しました")
        with open(out, "rb") as f:
            data = f.read()
        w, h = jpeg_size(data)
        return {"ok": True, "b64": base64.b64encode(data).decode(), "w": w, "h": h, "duration": duration}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("thumb")
    t.add_argument("path")
    t.add_argument("--size", type=int, default=200)
    args = ap.parse_args()
    try:
        out = cmd_thumb(args)
    except Fail as err:
        out = {"ok": False, "error": str(err)}
    except Exception as err:  # noqa: BLE001
        out = {"ok": False, "error": f"{type(err).__name__}: {err}"}
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0 if out["ok"] else 1)


if __name__ == "__main__":
    main()
