# プライバシーポリシー

最終更新: 2026-10-16

驚き屋スタジオ(odorokiya-studio、以下「この Mod」)は、Claude Code の中で動く Mod です。作者は自分のサーバーを持たず、この Mod から作者に届くデータはありません。この文書では、この Mod が利用者のマシンの中で何を読み、どこへ送り、何を残すかを説明します。

英語の要約は末尾にあります。

## 読むもの

- **X のアカウント名**: 接続の確認と、投稿後の URL を作るために、X API の `GET /2/users/me` で読みます。
- **画像と動画のファイル**: セッション中のツールの入出力に出てきたパスのうち、画像・動画の拡張子を持つファイルの有無と大きさを読み、パネル用の小さなサムネイルを作ります。一時フォルダ(`/tmp`、`/var/folders`)のものは読みません。
- **会話の内容**: 「会話から下書き」を押したとき、下書きを作るために、Claude Code 自身の仕組みでいまの会話を Claude に渡します。
- **X の鍵**: 利用者がプラグインの設定画面かパネルで入れた 4 つの鍵を、投稿や接続の確認のときに読みます。

名前、メールアドレス、住所などは扱いません。TL、通知、DM、他人の投稿も読みません。

## 送るもの

| 送り先 | 送るもの | いつ |
| --- | --- | --- |
| X(`https://api.x.com`) | 投稿の本文、選んだ画像や動画、OAuth 1.0a の署名 | 利用者が「投稿する」「接続を確認」「保存して接続テスト」を押したとき |
| Claude(Anthropic) | 会話の内容と本文 | 利用者が「会話から下書き」か推敲のボタンを押したとき。Claude Code 自身のモデル呼び出しを使います |

ここに書いた以外の宛先には送りません。作者に届くものはありません。X と Anthropic でのデータの扱いは、それぞれのプライバシーポリシーに従います。

## 残すもの

- **X の鍵**: 利用者の macOS のキーチェーン(service 名 `odorokiya-studio`)か、Claude Code の安全な保存場所にだけ保存します。消し方は [SECURITY.md](SECURITY.md) にあります。
- **素材の一覧、サムネイル、下書き**: そのセッションの間だけメモリに持ちます。ディスクには書きません。
- **サムネイル作成時の一時ファイル**: 作成後すぐ消します。

この Mod が独自に集計や解析をすることはありません。

## 問い合わせ

質問や要望は、GitHub の [Issues](https://github.com/KouyamaCreate/odorokiya-studio/issues) にお寄せください。セキュリティに関わるものは [SECURITY.md](SECURITY.md) の手順で、非公開で報告してください。

## English summary

Odorokiya Studio has no server of its own, and nothing reaches the author. It reads the user's X account name (via `GET /2/users/me`), media files that appear in the session (outside temp folders), the conversation when the user asks for a draft, and the X keys the user provided. It sends post text, selected media and OAuth signatures only to `https://api.x.com`, and only when the user presses a button. Drafting uses Claude Code's own model calls. Keys are stored only in the user's macOS keychain or Claude Code's secure storage. The media list, thumbnails and drafts are kept in memory for the session only and are never written to disk. No analytics are collected.
