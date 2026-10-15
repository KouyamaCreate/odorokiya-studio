// odorokiya-studio(驚き屋スタジオ): TL を一切開かずに、会話の文脈から驚き屋ツイートを起こし・推敲し・
// このセッションで出てきた画像・動画を添えて投稿する。TL・通知・他人の投稿は読まないし表示しない。
// 投稿は scripts/odorokiya.py (X API v2 / OAuth 1.0a) が行う。鍵は userConfig の sensitive 項目から
// 環境変数で渡すか、macOS キーチェーンから読む。
// 投稿は必ずパネルの「投稿」ボタン(=本人の操作)でだけ走る。モデルは下書きツールで下書きまで。
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { OdorokiyaKeyName, OdorokiyaMedia, OdorokiyaSetup, OdorokiyaStatus } from '../types'
import { ACCENT, chipSvg, counterSvg, mediaGridSvg, thumbSvg } from './svg'

// desktop はテーマ名の claude / success を黒で描くので、この2色だけは色コードで指定する
const OK = '#3F9B5F'
// 背景色は指定しない: desktop は Box の backgroundColor を描かず(2.1.295 で確認)、
// ターミナルでは逆に白い面が出てしまうため。背景はパネルを描くアプリ側に任せる。

const PANE = 'odorokiya-studio'
const TITLE = '驚き屋スタジオ'
const media = atom({ plugin: 'odorokiya-studio', key: 'media' } as const, [] as OdorokiyaMedia[])
const selected = atom({ plugin: 'odorokiya-studio', key: 'selected' } as const, [] as string[])
const text = atom({ plugin: 'odorokiya-studio', key: 'text' } as const, '')
const status = atom({ plugin: 'odorokiya-studio', key: 'status' } as const, { kind: 'idle' } as OdorokiyaStatus)
const account = atom({ plugin: 'odorokiya-studio', key: 'account' } as const, '')
const isBandHidden = atom({ plugin: 'odorokiya-studio', key: 'isBandHidden' } as const, false)
const candidates = atom({ plugin: 'odorokiya-studio', key: 'candidates' } as const, [] as string[])
const busy = atom({ plugin: 'odorokiya-studio', key: 'busy' } as const, '' as '' | 'draft' | 'polish')
const showAll = atom({ plugin: 'odorokiya-studio', key: 'showAll' } as const, false)
const bodyRev = atom({ plugin: 'odorokiya-studio', key: 'bodyRev' } as const, 0)
const setupOpen = atom({ plugin: 'odorokiya-studio', key: 'setupOpen' } as const, false)
const keyFilled = atom({ plugin: 'odorokiya-studio', key: 'keyFilled' } as const, 0)
const showSecurity = atom({ plugin: 'odorokiya-studio', key: 'showSecurity' } as const, false)
const keyRev = atom({ plugin: 'odorokiya-studio', key: 'keyRev' } as const, 0)
const setupNote = atom({ plugin: 'odorokiya-studio', key: 'setupNote' } as const, null as OdorokiyaSetup)
const setupBusy = atom({ plugin: 'odorokiya-studio', key: 'setupBusy' } as const, false)

const CONSOLE_URL = 'https://console.x.com'
const CALLBACK_URI = 'http://127.0.0.1/callback'
const KEY_FIELDS: ReadonlyArray<{ name: OdorokiyaKeyName; label: string; hint: string }> = [
  { name: 'consumer_key', label: 'API Key', hint: 'ここに貼る' },
  { name: 'consumer_secret', label: 'API Secret', hint: 'ここに貼る' },
  { name: 'access_token', label: 'Access Token', hint: 'ここに貼る' },
  { name: 'access_token_secret', label: 'Access Token Secret', hint: 'ここに貼る' },
]
// この Mod の鍵をキーチェーンや環境変数から読み出そうとする Bash を見分ける(純関数)。
// 書き方を変えたコマンドまでは捕まえられないので多重防御の 1 枚。README の「セキュリティ」に明記。
export const isKeyAccess = (command: string): boolean => {
  const c = command.replace(/\\\n/g, ' ')
  const ours = /(odorokiya-studio|x-post|ODOROKIYA_X_)/.test(c)
  const keychainRead = /\bsecurity\b[\s\S]*\b(find-generic-password|find-internet-password|dump-keychain|export|delete-generic-password|set-generic-password-partition-list)\b/.test(c)
  const dumpAll = /\bsecurity\b[\s\S]*\bdump-keychain\b/.test(c)
  const envRead = /\bODOROKIYA_X_[A-Z_]+/.test(c)
  return dumpAll || envRead || (ours && keychainRead)
}
const GUARD_REASON = '驚き屋スタジオ: X の鍵を読み出すコマンドは止めています(鍵は Mod の補助スクリプトだけが使います)。'

// 鍵の不備が原因のエラー。これが出たらウィザードを開く
const SETUP_CODES = new Set(['nokeys', 'auth', 'readonly', 'nokeychain'])

const RULES = [
  'あなたは X(旧Twitter)の「驚き屋」ツイートの書き手。新しいものを見つけて驚き、人に見せたくなる温度で書く。',
  '- 日本語。1案は全角140字以内(URLは23字換算)。',
  '- 事実ベース。作っていない機能・数字を盛らない。誇張は語気で出し、内容では出さない。',
  '- 1行目で何が起きたか分かるようにする。添付の画像・動画を見たくなる一言を入れる。',
  '- 絵文字は0〜2個、ハッシュタグは0〜1個。「〜を、〜に。」の型は使わない。',
  '- 出力は JSON の文字列配列だけ。説明や前置きは書かない。',
].join('\n')
const STYLES = [
  { key: 'max', label: 'MAX', ask: '勢いを最大に。最初の5文字で手を止めさせる。' },
  { key: 'short', label: '短く', ask: '全角60字以内に削る。' },
  { key: 'tech', label: '技術寄り', ask: '何をどう使って何が動いたかを具体的に。' },
  { key: 'calm', label: '冷静', ask: '煽らず淡々と事実だけで驚かせる。' },
] as const

// モデルの返事から JSON 文字列配列を取り出す(純関数)
export const parseCandidates = (reply: string): string[] => {
  const m = reply.match(/\[[\s\S]*\]/)
  if (!m) return reply.trim() ? [reply.trim()] : []
  try {
    const v: unknown = JSON.parse(m[0])
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, 5) : []
  } catch {
    return []
  }
}

const EXT = 'png|jpe?g|gif|webp|mp4|mov|m4v|webm'
const WHOLE = new RegExp(`\\.(?:${EXT})$`, 'i')
const EMBEDDED = new RegExp(`(?:^|[\\s'"=(\`])(\\/[^\\s'"()<>|;\`]+\\.(?:${EXT}))(?=$|[\\s'"),;:\`])`, 'gi')
const MAX_MEDIA = 50
const THUMB_SIZE = 320
const MAX_THUMBS = 24
const LIMIT = 280

// 一時フォルダの画像は拾わない。Claude が動作確認のために撮ったスクリーンショットなど、
// 人に見せる前提ではないもの(会話や画面の中身が写りがち)が多いため。下書きツールで明示されたものは別。
export const isTemporaryPath = (path: string): boolean =>
  /^\/(private\/)?(tmp|var\/folders|var\/tmp)\//.test(path)

// 文字列・配列・オブジェクトを辿ってメディアっぽいパスを集める(純関数)
const collect = (value: unknown, cwd: string, out: Set<string>, depth = 0): void => {
  if (depth > 8 || out.size > 200) return
  if (typeof value === 'string') {
    const s = value.trim()
    if (s.length < 4096 && WHOLE.test(s) && !s.includes('\n') && !/^https?:/i.test(s)) {
      if (s.startsWith('/')) out.add(s)
      else if (!s.startsWith('~')) out.add(`${cwd}/${s.replace(/^\.\//, '')}`)
    }
    for (const m of s.slice(0, 200_000).matchAll(EMBEDDED)) if (m[1]) out.add(m[1])
    return
  }
  if (Array.isArray(value)) {
    for (const v of value) collect(v, cwd, out, depth + 1)
    return
  }
  if (value && typeof value === 'object') for (const v of Object.values(value)) collect(v, cwd, out, depth + 1)
}

const kindOf = (path: string): OdorokiyaMedia['kind'] =>
  /\.gif$/i.test(path) ? 'gif' : /\.(mp4|mov|m4v|webm)$/i.test(path) ? 'video' : 'image'

const baseName = (path: string) => path.split('/').pop() ?? path

const human = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`

// X の重み付き文字数(概算): URL は 23、Latin 系は 1、それ以外(日本語など)は 2
export const weightedLength = (s: string): number => {
  let n = 0
  const rest = s.replace(/https?:\/\/\S+/g, () => {
    n += 23
    return ''
  })
  for (const ch of rest) {
    const c = ch.codePointAt(0) ?? 0
    const light = c <= 0x10ff || (c >= 0x2000 && c <= 0x200d) || (c >= 0x2010 && c <= 0x201f) || (c >= 0x2032 && c <= 0x2037)
    n += light ? 1 : 2
  }
  return n
}

// 選択の妥当性: 画像は4枚まで、GIF/動画は単独1本
export const selectionError = (items: readonly OdorokiyaMedia[]): string | undefined => {
  const heavy = items.filter(m => m.kind !== 'image')
  if (heavy.length > 0 && items.length > 1) return 'GIF・動画は1本だけで、他と一緒には添付できません'
  if (items.length > 4) return '画像は4枚までです'
  const big = items.find(m => (m.kind === 'image' && m.size > 5 * 1024 * 1024) || (m.kind === 'gif' && m.size > 15 * 1024 * 1024))
  if (big) return `${big.name} が大きすぎます(画像5MB / GIF15MBまで)`
  return undefined
}

// 追加しつつ、古いもののサムネイルは捨てて state を軽く保つ
const addMedia = (found: readonly OdorokiyaMedia[]) => (list: OdorokiyaMedia[]) => {
  const fresh = new Map(found.map(m => [m.path, m]))
  const merged = [...list.map(m => fresh.get(m.path) ?? m), ...found.filter(m => !list.some(o => o.path === m.path))].slice(-MAX_MEDIA)
  return merged.map((m, i) => (i < merged.length - MAX_THUMBS && m.thumb ? { ...m, thumb: undefined } : m))
}

// 高さと幅は width / height と書く(.tsx では h という名前を要素作成の関数にしか使えないため)
type Thumb = { ok: boolean; b64?: string; width?: number; height?: number; duration?: number | null }
const parseThumb = (stdout: string): Thumb => {
  try {
    return JSON.parse(stdout.trim().split('\n').pop() ?? '')
  } catch {
    return { ok: false }
  }
}
const withThumb = (m: OdorokiyaMedia, t: Thumb): OdorokiyaMedia =>
  t.ok && t.b64 ? { ...m, thumb: t.b64, width: t.width, height: t.height, duration: t.duration ?? null } : m

const shortName = (name: string, max = 14) => (name.length <= max ? name : `${name.slice(0, max - 5)}…${name.slice(-4)}`)

const parseResult = (stdout: string): { ok: boolean; url?: string; username?: string; error?: string; code?: string } => {
  const line = stdout.trim().split('\n').pop() ?? ''
  try {
    return JSON.parse(line)
  } catch {
    return { ok: false, error: line || '補助スクリプトの出力が読めません' }
  }
}

// userConfig の鍵を補助スクリプトへ渡す環境変数にする(コマンドライン引数には載せない)
export const credentialEnv = (options: Readonly<Record<string, unknown>>): Record<string, string> => {
  const pick = (k: string) => (typeof options[k] === 'string' ? (options[k] as string).trim() : '')
  const env: Record<string, string> = {
    ODOROKIYA_X_API_KEY: pick('x_api_key'),
    ODOROKIYA_X_API_SECRET: pick('x_api_secret'),
    ODOROKIYA_X_ACCESS_TOKEN: pick('x_access_token'),
    ODOROKIYA_X_ACCESS_TOKEN_SECRET: pick('x_access_token_secret'),
  }
  return Object.values(env).every(v => v !== '') ? env : {}
}

export const register: Register = (on, options) => {
  const env = credentialEnv(options)
  const confirmEnv: Record<string, string> = options.keychain_confirm === true ? { ODOROKIYA_KEYCHAIN_CONFIRM: '1' } : {}
  // ウィザードで入力中の鍵はこの Mod の中だけに持つ。state や store には置かない
  const typed = new Map<OdorokiyaKeyName, string>()

  // ---- Bash からこの Mod の鍵を読み出させない ----
  on('tool.call', { tool: 'Bash' }, ($, e, next) =>
    isKeyAccess(String(e.command ?? '')) ? { deny: GUARD_REASON } : next(e),
  ).catch(($, e, next) => (isKeyAccess(String((e as { command?: unknown }).command ?? '')) ? { deny: GUARD_REASON } : next(e)))

  const WRITER = typeof options.writer_model === 'string' && options.writer_model !== '' ? options.writer_model : 'sonnet'
  const showBand = options.show_band !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'odorokiya-studio', description: '驚き屋スタジオを開く: TLを見ずに推敲して投稿(引数は本文の初期値)' })
    await $.command.register({ name: 'odorokiya-studio-security', description: '驚き屋スタジオ: 鍵の扱いとセキュリティの説明を表示する' })
    await $.command.register({ name: 'odorokiya-studio-check', description: '驚き屋スタジオ: X の認証情報を確認する' })
    await $.tool.register({
      name: 'draft',
      description:
        '驚き屋スタジオ(X 投稿パネル)に下書きを入れる。text はツイート本文、media は添付する画像・動画の絶対パス(画像4枚まで、動画/GIFは1本)。' +
        '投稿はしない。ユーザーがパネルの投稿ボタンを押したときだけ投稿される。ユーザーがツイート・投稿・Xへのシェアを頼んだときに使う。',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'ツイート本文' },
          media: { type: 'array', items: { type: 'string' }, description: '添付するファイルの絶対パス' },
        },
      },
      isDeferred: false,
    })
    return next(e)
  })

  // ---- セッション中のツール入出力からメディアを拾う ----
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (String(e.tool).startsWith('mcp__odorokiya-studio__')) return ran
    try {
      const cwd = await $.session.cwd()
      const paths = new Set<string>()
      collect(e, cwd, paths)
      if (ran.deny === undefined) {
        collect(ran.text, cwd, paths)
        collect(ran.result, cwd, paths)
      }
      const now = Date.now()
      const found: OdorokiyaMedia[] = []
      for (const path of paths) {
        if (isTemporaryPath(path)) continue
        try {
          const st = await $.fs.stat(path)
          if (st.kind === 'file' && st.size > 0)
            found.push({ path, name: baseName(path), kind: kindOf(path), size: st.size, at: now + found.length })
        } catch {
          // まだ無いパス・読めないパスは無視
        }
      }
      const known = new Set((await read($, media)).map(m => m.path))
      for (const [i, m] of found.entries()) {
        if (known.has(m.path) || i >= 4) continue
        try {
          const run = await $.process.run(['/usr/bin/python3', '-I', $.plugin.root + '/scripts/media.py', 'thumb', m.path, '--size', String(THUMB_SIZE)], { env, timeoutMs: 15_000 })
          found[i] = withThumb(m, parseThumb(run.stdout))
        } catch {
          // サムネイルが無くても素材としては使える
        }
      }
      if (found.length > 0) {
        await update($, media, addMedia(found))
        await update($, isBandHidden, () => false)
      }
    } catch {
      // 収集の失敗でツール呼び出しを邪魔しない
    }
    return ran
  })

  // ---- モデル用: 下書きを入れるだけ ----
  on('tool.call', { tool: 'mcp__odorokiya-studio__draft' }, async ($, e) => {
    const draftText = typeof e.text === 'string' ? e.text : undefined
    const wanted = Array.isArray(e.media) ? e.media.filter((p): p is string => typeof p === 'string') : []
    const found: OdorokiyaMedia[] = []
    const missing: string[] = []
    const now = Date.now()
    for (const path of wanted) {
      try {
        const st = await $.fs.stat(path)
        if (st.kind === 'file') found.push({ path, name: baseName(path), kind: kindOf(path), size: st.size, at: now + found.length })
        else missing.push(path)
      } catch {
        missing.push(path)
      }
    }
    for (const [i, m] of found.entries()) {
      try {
        const run = await $.process.run(['/usr/bin/python3', '-I', $.plugin.root + '/scripts/media.py', 'thumb', m.path, '--size', String(THUMB_SIZE)], { env, timeoutMs: 15_000 })
        found[i] = withThumb(m, parseThumb(run.stdout))
      } catch {
        // サムネイル無しで続ける
      }
    }
    if (found.length > 0) await update($, media, addMedia(found))
    if (wanted.length > 0) await update($, selected, () => found.map(m => m.path))
    if (draftText !== undefined) {
      await update($, text, () => draftText)
      await update($, bodyRev, n => n + 1)
    }
    await update($, status, () => ({ kind: 'idle' }) as OdorokiyaStatus)
    if ((await read($, account)) === '') {
      try {
        const run = await $.process.run(['/usr/bin/python3', '-I', $.plugin.root + '/scripts/odorokiya.py', 'check'], { env, timeoutMs: 20_000 })
        const out = parseResult(run.stdout)
        if (out.ok && out.username) await update($, account, () => out.username ?? '')
        else await update($, setupNote, () => ({ message: out.error ?? '接続できませんでした', isError: out.code !== 'nokeys' }))
      } catch {
        // 未接続のまま
      }
    }
    // 消えたファイルを一覧から外す
    const vanished: string[] = []
    for (const m of await read($, media)) {
      try {
        if (!(await $.fs.exists(m.path))) vanished.push(m.path)
      } catch {
        // 確かめられないものは残す
      }
    }
    // 一時フォルダのものは、いま添付に選んでいるもの以外を外す(以前に拾ってしまった確認用画像など)
    const keep = new Set(await read($, selected))
    await update($, media, cur => cur.filter(m => !vanished.includes(m.path) && (!isTemporaryPath(m.path) || keep.has(m.path))))
    // 新しい下書きが主役になるよう、前の候補や開きっぱなしの説明を片づける
    await update($, candidates, () => [])
    await update($, showSecurity, () => false)
    if ((await read($, account)) !== '') await update($, setupOpen, () => false)
    await $.ui.open({ id: PANE, title: TITLE })
    const problem = selectionError(found)
    const note = [
      '下書きを驚き屋スタジオに入れました。投稿はユーザーがパネルの「投稿」ボタンを押したときだけ行われます。',
      missing.length > 0 ? `見つからなかったファイル: ${missing.join(', ')}` : '',
      problem ? `注意: ${problem}` : '',
      draftText !== undefined ? `文字数(重み付き概算): ${weightedLength(draftText)}/${LIMIT}` : '',
    ].filter(Boolean).join('\n')
    return { result: note, text: note }
  })

  // ---- コマンド ----
  on('command.run', { command: 'odorokiya-studio' }, async ($, e) => {
    if (e.args.trim() !== '') {
      await update($, text, () => e.args.trim())
      await update($, bodyRev, n => n + 1)
    }
    // 消えたファイルを一覧と選択から外す
    const gone: string[] = []
    for (const m of await read($, media)) {
      try {
        if (!(await $.fs.exists(m.path))) gone.push(m.path)
      } catch {
        // 確かめられないものは残す
      }
    }
    await update($, selected, cur => cur.filter(p => !gone.includes(p)))
    const keepPicked = new Set(await read($, selected))
    await update($, media, cur => cur.filter(m => !gone.includes(m.path) && (!isTemporaryPath(m.path) || keepPicked.has(m.path))))
    // サムネイルの無い直近の素材を補う
    const missing = (await read($, media)).slice(-8).filter(m => !m.thumb)
    const filled: OdorokiyaMedia[] = []
    for (const m of missing) {
      try {
        const run = await $.process.run(['/usr/bin/python3', '-I', $.plugin.root + '/scripts/media.py', 'thumb', m.path, '--size', String(THUMB_SIZE)], { env, timeoutMs: 15_000 })
        filled.push(withThumb(m, parseThumb(run.stdout)))
      } catch {
        // 消えたファイルなどは飛ばす
      }
    }
    if (filled.length > 0) await update($, media, addMedia(filled))
    const list = await read($, media)
    const latest = list[list.length - 1]
    if (latest && (await read($, selected)).length === 0) await update($, selected, () => [latest.path])
    if ((await read($, account)) === '') {
      try {
        const run = await $.process.run(['/usr/bin/python3', '-I', $.plugin.root + '/scripts/odorokiya.py', 'check'], { env, timeoutMs: 20_000 })
        const out = parseResult(run.stdout)
        if (out.ok && out.username) await update($, account, () => out.username ?? '')
        else await update($, setupNote, () => ({ message: out.error ?? '接続できませんでした', isError: out.code !== 'nokeys' }))
      } catch {
        // 未接続のままパネルを開く
      }
    }
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    return { text: '驚き屋スタジオを開きました。' }
  })

  on('command.run', { command: 'odorokiya-studio-security' }, async $ => {
    try {
      return { text: await $.fs.read($.plugin.root + '/SECURITY.md') }
    } catch {
      return { text: 'SECURITY.md を読めませんでした。https://github.com/KouyamaCreate/odorokiya-studio/blob/main/SECURITY.md を見てください。' }
    }
  })

  on('command.run', { command: 'odorokiya-studio-check' }, async $ => {
    const run = await $.process.run(['/usr/bin/python3', '-I', $.plugin.root + '/scripts/odorokiya.py', 'check'], { env, timeoutMs: 30_000 })
    const out = parseResult(run.stdout)
    if (out.ok && out.username) await update($, account, () => out.username ?? '')
    return { text: out.ok ? `X の認証 OK: @${out.username}` : `X の認証に失敗: ${out.error ?? run.stderr.slice(0, 300)}` }
  })

  // ---- 入力欄の上の帯: 新しい素材が出たら案内 ----
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!showBand || e.props.hasSurvey || (await read($, isBandHidden))) return next(e)
    const list = await read($, media)
    const latest = list[list.length - 1]
    if (!latest) return next(e)
    const t = $.ui.resolve(e)
    const { Box, Text, Button } = t
    const Svg = 'Svg' in t ? t.Svg : undefined
    return (
      <Box gap={1} alignItems="center">
        {Svg && <Svg source={chipSvg(latest)} alt={latest.name} width={30} height={30} />}
        <Text>
          <Text color={ACCENT} bold>驚き屋チャンス</Text> <Text color="subtle">{shortName(latest.name, 28)}{list.length > 1 ? ` ほか${list.length - 1}件` : ''}</Text>
        </Text>
        <Button key="tweet" label="TLを見ずにツイート" variant="primary" onPress={async () => {
          await update($, selected, () => [latest.path])
          await update($, status, () => ({ kind: 'idle' }) as OdorokiyaStatus)
          await $.ui.open({ id: PANE, title: TITLE, focus: true })
        }} />
        <Button key="hide" label="隠す" role="dismiss" onPress={() => update($, isBandHidden, () => true)} />
      </Box>
    )
  })

  // ---- 驚き屋スタジオ(パネル) ----
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const list = await read($, media)
    const picks = await read($, selected)
    const body = await read($, text)
    const st = await read($, status)
    const who = await read($, account)
    const ideas = await read($, candidates)
    const working = await read($, busy)
    const t = $.ui.resolve(e)
    const { Box, Text, Button, Link, Markdown } = t
    const Input = 'Input' in t ? t.Input : undefined
    const Svg = 'Svg' in t ? t.Svg : undefined

    const chosen = picks.map(p => list.find(m => m.path === p)).filter((m): m is OdorokiyaMedia => m !== undefined)
    const problem = selectionError(chosen)
    const count = weightedLength(body)
    const isOver = count > LIMIT
    const isEmpty = body.trim() === '' && chosen.length === 0
    const isPosting = st.kind === 'posting'
    const canPost = !isPosting && !problem && !isOver && !isEmpty
    const pickNote = problem ? '選択を見直してください' : chosen.length === 0 ? '押して選択' : `${chosen.length} 件を添付`
    const postLabel = isPosting ? '投稿しています…' : problem ? '添付を見直してください' : isOver ? '文字数オーバー' : isEmpty ? '本文を入力' : '投稿する'
    const attached = chosen.map(m => `${m.name}(${m.kind})`).join(', ') || 'なし'
    const isAll = await read($, showAll)
    const rev = await read($, bodyRev)
    const isSetupOpen = who === '' || (await read($, setupOpen))
    const filled = await read($, keyFilled)
    const isSecurityOpen = await read($, showSecurity)
    let securityText = ''
    if (isSecurityOpen) {
      try {
        securityText = await $.fs.read($.plugin.root + '/SECURITY.md')
      } catch {
        securityText = 'SECURITY.md を読めませんでした。リポジトリの SECURITY.md を見てください。'
      }
    }
    const kRev = await read($, keyRev)
    const note = await read($, setupNote)
    const isSaving = await read($, setupBusy)
    const usesSettings = Object.keys(env).length > 0

    const shown = list.slice(isAll ? -24 : -6).reverse()
    const previewWidth = Math.max(240, Math.min(400, Math.round(e.props.bodyColumns * 7.5) - 24))

    const toggle = (path: string) => update($, selected, cur => (cur.includes(path) ? cur.filter(p => p !== path) : [...cur, path]))

    const post = async () => {
      if (!canPost) return
      await update($, status, () => ({ kind: 'posting' }) as OdorokiyaStatus)
      const argv = ['/usr/bin/python3', '-I', $.plugin.root + '/scripts/odorokiya.py', 'post', '--text', body, ...chosen.flatMap(m => ['--media', m.path])]
      try {
        const run = await $.process.run(argv, { env, timeoutMs: 600_000 })
        const out = parseResult(run.stdout)
        if (out.ok && out.url) {
          const url = out.url
          await update($, status, () => ({ kind: 'done', url }) as OdorokiyaStatus)
          await update($, text, () => '')
          await update($, bodyRev, n => n + 1)
          await update($, selected, () => [])
          await update($, candidates, () => [])
          $.ui.toast('X に投稿しました')
          void $.ui.notify('X に投稿しました', { title: '驚き屋スタジオ' })
        } else {
          const message = out.error ?? (run.stderr.slice(0, 300) || `exit ${run.exitCode}`)
          await update($, status, () => ({ kind: 'error', message, code: out.code }) as OdorokiyaStatus)
          if (out.code && SETUP_CODES.has(out.code)) await update($, setupOpen, () => true)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await update($, status, () => ({ kind: 'error', message }) as OdorokiyaStatus)
      }
    }

    const check = async () => {
      const run = await $.process.run(['/usr/bin/python3', '-I', $.plugin.root + '/scripts/odorokiya.py', 'check'], { env, timeoutMs: 30_000 })
      const out = parseResult(run.stdout)
      if (out.ok && out.username) {
        await update($, account, () => out.username ?? '')
        await update($, setupNote, () => ({ message: `@${out.username} とつながっています`, isError: false }))
      } else {
        await update($, account, () => '')
        await update($, setupNote, () => ({ message: out.error ?? '認証の確認に失敗しました', isError: true }))
        await update($, setupOpen, () => true)
      }
    }

    // ウィザード: 入力された 4 つの鍵を標準入力で渡してキーチェーンに保存し、そのまま接続を確かめる
    const saveKeys = async () => {
      if (await read($, setupBusy)) return
      await update($, setupBusy, () => true)
      try {
        const draft = Object.fromEntries(typed)
        // 成否にかかわらず、渡したらすぐ手元から消す(失敗したら貼り直してもらう)
        typed.clear()
        await update($, keyFilled, () => 0)
        await update($, keyRev, n => n + 1)
        const run = await $.process.run(['/usr/bin/python3', '-I', $.plugin.root + '/scripts/odorokiya.py', 'save-keys'], {
          stdin: JSON.stringify(draft),
          env: confirmEnv,
          timeoutMs: 60_000,
        })
        const out = parseResult(run.stdout)
        if (out.ok && out.username) {
          const name = out.username
          await update($, account, () => name)
          await update($, setupNote, () => ({ message: `@${name} とつながりました`, isError: false }))
          await update($, setupOpen, () => false)
          await update($, status, () => ({ kind: 'idle' }) as OdorokiyaStatus)
          $.ui.toast(`X とつながりました: @${name}`)
        } else {
          await update($, setupNote, () => ({ message: `${out.error ?? '保存に失敗しました'}(安全のため入力欄は空にしました。貼り直してください)`, isError: true }))
        }
      } finally {
        await update($, setupBusy, () => false)
      }
    }

    // 会話そのものを読んで、何を作ったかから候補を起こす
    const draftFromSession = async () => {
      if (working) return
      await update($, busy, () => 'draft' as const)
      const r = await $.model.fork({
        prompt: `${RULES}\n\nこの会話で作ったもの・できるようになったことを、驚き屋ツイートの候補にして3案出して。添付予定の素材: ${attached}`,
      })
      await update($, busy, () => '' as const)
      if (r.isAnswered) await update($, candidates, () => parseCandidates(r.text))
      else await update($, status, () => ({ kind: 'error', message: `下書きできませんでした(${r.reason})` }) as OdorokiyaStatus)
    }

    const polish = async (ask: string) => {
      if (working || body.trim() === '') return
      await update($, busy, () => 'polish' as const)
      const r = await $.model.complete({
        model: WRITER,
        system: RULES,
        prompt: `次のツイート案を推敲して3案出して。方針: ${ask}\n添付予定の素材: ${attached}\n\n元の案:\n${body}`,
      })
      await update($, busy, () => '' as const)
      if (r.isAnswered) await update($, candidates, () => parseCandidates(r.text))
      else await update($, status, () => ({ kind: 'error', message: `推敲できませんでした(${r.reason})` }) as OdorokiyaStatus)
    }

    const heading = (title: string, aside?: string) => (
      <Box justifyContent="space-between">
        <Text bold>{title}</Text>
        {aside !== undefined && <Text color="subtle">{aside}</Text>}
      </Box>
    )

    // 投稿完了: それだけを静かに見せて、TL へは誘導しない
    if (st.kind === 'done') {
      return (
        <Box flexDirection="column" gap={1} paddingX={1} paddingY={1}>
          <Box borderStyle="round" borderColor={OK} paddingX={2} paddingY={1} flexDirection="column" gap={1}>
            <Text color={OK} bold>✓ 投稿しました</Text>
            <Text color="subtle">TL は開いていません。このまま作業に戻れます。</Text>
            <Box gap={1}>
              <Button key="next" label="次を書く" variant="primary" onPress={() => update($, status, () => ({ kind: 'idle' }) as OdorokiyaStatus)} />
              <Button key="copy-url" label="URLをコピー" onPress={() => void $.ui.copy({ text: st.url, surface: e.surface })} />
            </Box>
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1} paddingX={1} paddingY={1}>
        {/* ヘッダー */}
        <Box justifyContent="space-between" alignItems="center">
          <Text color="subtle">TL を開かずに投稿まで</Text>
          <Box gap={1} alignItems="center">
            {who !== '' && <Text color="subtle">@{who}</Text>}
            <Button key="account" label={who ? '接続設定' : '接続を確認'} onPress={who ? () => update($, setupOpen, v => !v) : check} />
          </Box>
        </Box>

        {/* X とつなぐ */}
        {isSetupOpen && (
          <Box borderStyle="round" borderColor={ACCENT} paddingX={2} paddingY={1} flexDirection="column" gap={1}>
            <Box justifyContent="space-between" alignItems="center">
              <Text bold>X とつなぐ</Text>
              {who !== '' && <Button key="setup-close" label="閉じる" role="dismiss" onPress={async () => {
                typed.clear()
                await update($, keyFilled, () => 0)
                await update($, keyRev, n => n + 1)
                await update($, setupOpen, () => false)
              }} />}
            </Box>
            {who !== ''
              ? <Text color="subtle">現在 @{who} とつながっています。鍵を入れ直すときだけ、下の手順 3 から進めてください。</Text>
              : <Text color="subtle">最初の 1 回だけ。X Developer Console でアプリを作り、4 つの鍵をここに貼ります。</Text>}

            <Text bold>1. アプリを作る</Text>
            <Box gap={1} alignItems="center">
              <Link href={CONSOLE_URL}>X Developer Console を開く</Link>
              <Text color="subtle">→ New App(名前は何でも可)</Text>
            </Box>

            <Text bold>2. 投稿できる権限にする</Text>
            <Text color="subtle">アプリの User authentication settings で、App permissions を Read and write、Type of App を Web App, Automated App or Bot にして保存します。</Text>
            <Box gap={1} alignItems="center" flexWrap="wrap">
              <Text color="subtle">Callback URI(必須・使いません):</Text>
              <Text>{CALLBACK_URI}</Text>
              <Button key="copy-callback" label="コピー" onPress={() => void $.ui.copy({ text: CALLBACK_URI, surface: e.surface })} />
            </Box>
            <Text color="subtle">Website URL(必須)は自分の X のプロフィール URL で構いません。</Text>

            <Text bold>3. 鍵を発行して貼る</Text>
            <Text color="subtle">Keys and tokens で API Key と API Secret(Consumer Key / Secret とも呼ばれます)、続けて Access Token と Access Token Secret を発行します。Access Token は手順 2 のあとで発行してください(先に作ったものは読み取り専用です)。</Text>
            {usesSettings ? (
              <Text color="subtle">プラグインの設定画面に入れた鍵を使っています。直すときは設定画面で入れ直してください。</Text>
            ) : Input ? (
              <Box flexDirection="column" gap={1}>
                {KEY_FIELDS.map(f => (
                  <Input key={`k-${f.name}-${kRev}`} label={f.label} placeholder={f.hint}
                    onInput={v => {
                      if (v.trim() === '') typed.delete(f.name)
                      else typed.set(f.name, v)
                      void update($, keyFilled, () => typed.size)
                    }}
                    onSubmit={v => {
                      if (v.trim() !== '') typed.set(f.name, v)
                      void update($, keyFilled, () => typed.size)
                    }} />
                ))}
                <Text color="subtle">貼った値はこの欄に見えています。画面共有や録画の最中は貼らないでください。保存を押すと欄は空になり、鍵は macOS のキーチェーン(odorokiya-studio)にだけ残ります。</Text>
                <Box gap={1} alignItems="center">
                  <Button key="save-keys" label={isSaving ? '確認しています…' : filled === 4 ? '保存して接続テスト' : `保存して接続テスト(${filled}/4)`}
                    variant={filled === 4 ? 'primary' : 'secondary'} onPress={saveKeys} />
                  <Button key="recheck" label="接続を確認" onPress={check} />
                </Box>
              </Box>
            ) : (
              <Text color="subtle">この画面では鍵を入力できません。README の手順でキーチェーンに入れてから「接続を確認」を押してください。</Text>
            )}
            {note && <Text color={note.isError ? 'error' : 'subtle'}>{note.message}</Text>}
            <Button key="security" label={isSecurityOpen ? 'セキュリティの説明を閉じる' : '鍵の扱いとセキュリティについて'} plain onPress={() => update($, showSecurity, v => !v)} />
            {isSecurityOpen && <Markdown text={securityText} />}
          </Box>
        )}

        {/* 素材 */}
        <Box flexDirection="column" gap={1}>
          {heading('素材', list.length === 0 ? '' : pickNote)}
          {shown.length === 0 && (
            <Text color="subtle">まだありません。セッションで画像や動画ができると、ここに並びます。</Text>
          )}
          {Svg ? (
            <Box flexDirection="row" flexWrap="wrap" gap={1}>
              {shown.map(m => {
                const order = picks.indexOf(m.path)
                return (
                  <Box key={`tile-${m.at}`} flexDirection="column" alignItems="center" width={14}>
                    <Svg source={thumbSvg(m, order >= 0 ? order + 1 : undefined)} alt={m.name} width={92} height={92} />
                    <Button key={`m-${m.at}`} plain onPress={() => toggle(m.path)}>
                      {order >= 0 ? <Text color={ACCENT}>✓ {shortName(m.name, 11)}</Text> : <Text color="subtle">{shortName(m.name, 12)}</Text>}
                    </Button>
                  </Box>
                )
              })}
            </Box>
          ) : (
            shown.map(m => (
              <Button key={`m-${m.at}`} plain onPress={() => toggle(m.path)}>
                {picks.includes(m.path) ? <Text color={ACCENT}>● </Text> : <Text color="subtle">○ </Text>}{m.name} <Text color="subtle">{m.kind} · {human(m.size)}</Text>
              </Button>
            ))
          )}
          {list.length > 0 && (
            <Box gap={1}>
              {list.length > 6 && (
                <Button key="more" label={isAll ? 'たたむ' : `すべて表示（${list.length}）`} onPress={() => update($, showAll, v => !v)} />
              )}
              {list.length > chosen.length && (
                <Button key="prune" label="選択以外を外す" onPress={() => update($, media, cur => cur.filter(m => picks.includes(m.path)))} />
              )}
            </Box>
          )}
          {problem && <Text color="error">{problem}</Text>}
        </Box>

        {/* 本文と推敲 */}
        <Box flexDirection="column" gap={1}>
          <Box justifyContent="space-between" alignItems="center">
            <Text bold>本文</Text>
            <Box gap={1} alignItems="center">
              {Svg && <Svg source={counterSvg(count, LIMIT)} alt={`${count}/${LIMIT}`} width={26} height={26} />}
              <Text color={isOver ? 'error' : 'subtle'}>{count}/{LIMIT}</Text>
            </Box>
          </Box>
          {Input && (
            <Box flexDirection="column" width="100%">
              <Input key={`body-${rev}`} placeholder="何に驚いた？" value={body}
                onInput={v => void update($, text, () => v)}
                onSubmit={v => void update($, text, () => v)} />
            </Box>
          )}
          <Button key="draft" label={working === 'draft' ? '会話を読んでいます…' : '✦ 会話から下書き'} variant="primary" onPress={draftFromSession} />
          <Box gap={1} alignItems="center">
            <Text color="subtle">推敲</Text>
            {STYLES.map(s => (
              <Button key={`style-${s.key}`} label={s.label} onPress={() => polish(s.ask)} />
            ))}
          </Box>
          {working === 'polish' && <Text color={ACCENT}>推敲しています…</Text>}
          {ideas.map((idea, i) => (
            <Box key={`idea-${i}`} borderStyle="round" borderColor={idea === body ? ACCENT : 'subtle'} hover={{ borderColor: ACCENT }} paddingX={1} paddingY={1} flexDirection="column" gap={1}>
              <Text>{idea}</Text>
              <Box justifyContent="space-between" alignItems="center">
                <Text color="subtle">{weightedLength(idea)}/{LIMIT}</Text>
                <Button key={`use-${i}`} label="これを使う" onPress={async () => {
                  await update($, text, () => idea)
                  await update($, bodyRev, n => n + 1)
                  await update($, candidates, () => [])
                }} />
              </Box>
            </Box>
          ))}
        </Box>

        {st.kind === 'error' && (
          <Box borderStyle="round" borderColor="error" paddingX={1} flexDirection="column">
            <Text color="error">{st.message}</Text>
            {st.code !== undefined && SETUP_CODES.has(st.code) && !isSetupOpen && (
              <Button key="fix-keys" label="鍵を入れ直す" onPress={() => update($, setupOpen, () => true)} />
            )}
          </Box>
        )}

        {/* 投稿 */}
        <Box justifyContent="space-between" alignItems="center">
          <Button key="clear" label="クリア" onPress={async () => {
            await update($, selected, () => [])
            await update($, text, () => '')
            await update($, bodyRev, n => n + 1)
            await update($, candidates, () => [])
            await update($, status, () => ({ kind: 'idle' }) as OdorokiyaStatus)
          }} />
          <Button key="post" label={postLabel} variant={canPost || isPosting ? 'primary' : 'secondary'} onPress={post} />
        </Box>

        {/* プレビュー */}
        <Box flexDirection="column" gap={1}>
          {heading('プレビュー')}
          <Box borderStyle="round" borderColor="promptBorder" paddingX={2} paddingY={1} flexDirection="column" gap={1}>
            <Text>
              <Text bold>{who ? `@${who}` : 'あなた'}</Text><Text color="subtle"> · いま</Text>
            </Text>
            {body.trim() === '' ? <Text color="subtle">本文がまだありません</Text> : <Text>{body}</Text>}
            {Svg && chosen.length > 0 && (
              <Svg source={mediaGridSvg(chosen, previewWidth)} alt={`添付 ${chosen.length} 件`} width={previewWidth} />
            )}
            {!Svg && chosen.length > 0 && <Text color="subtle">添付: {chosen.map(m => m.name).join(', ')}</Text>}
          </Box>
        </Box>

      </Box>
    )
  })
}
