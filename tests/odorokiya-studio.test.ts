import { expect, test } from 'claude-code/testing'

import { credentialEnv, isKeyAccess, isTemporaryPath, parseCandidates, selectionError, weightedLength } from '../hooks/register'

const img = (name: string, size = 1000) => ({ path: `/tmp/${name}`, name, kind: 'image' as const, size, at: 0 })
const vid = { path: '/tmp/demo.mp4', name: 'demo.mp4', kind: 'video' as const, size: 1000, at: 0 }

test('文字数は日本語2・英字1・URL23で数える', async () => {
  expect(weightedLength('abc')).toBe(3)
  expect(weightedLength('驚き')).toBe(4)
  expect(weightedLength('見て https://example.com/very/long/path')).toBe(4 + 1 + 23)
})

test('添付ルール: 画像4枚まで、動画は単独', async () => {
  expect(selectionError([img('a.png'), img('b.png'), img('c.png'), img('d.png')])).toBeUndefined()
  expect(selectionError([img('a.png'), img('b.png'), img('c.png'), img('d.png'), img('e.png')])).toBeDefined()
  expect(selectionError([vid, img('a.png')])).toBeDefined()
  expect(selectionError([vid])).toBeUndefined()
  expect(selectionError([img('big.png', 6 * 1024 * 1024)])).toBeDefined()
})

test('候補は JSON 配列を前置き付きでも取り出す', async () => {
  expect(parseCandidates('はい\n["案1", "案2"]\n以上')).toEqual(['案1', '案2'])
  expect(parseCandidates('壊れた [ "x"')).toEqual(['壊れた [ "x"'])
})

test('ツール入出力から画像パスを拾い、帯に出る', async ($, on) => {
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.stat', ($, e) => ({ value: { kind: 'file', size: 2048, mtimeMs: 0, isLink: false } }))
  on('tool.call', () => ({ result: 'saved to /work/out/demo shot.png and /work/b.mp4', text: 'saved /work/b.mp4' }))
  on('ui.render', () => h('Text', {}, 'engine'))
  await $.tool.call({ tool: 'Write', file_path: '/work/out/demo shot.png', content: 'x' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'odorokiya-studio', surface, component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 9 }, view: {} },
    })
    expect(await ui.find({ type: 'Text', text: /驚き屋チャンス/ })).toBeDefined()
    await ui.unmount()
  }
})

test('下書きツールでパネルに本文と素材が入り、各サーフェスで描ける', async ($, on) => {
  on('fs.stat', () => ({ value: { kind: 'file', size: 2048, mtimeMs: 0, isLink: false } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.render', () => h('Text', {}, 'engine'))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '{"ok": true, "b64": "AAAA", "w": 10, "h": 10, "duration": null}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  await $.tool.call({ tool: 'mcp__odorokiya-studio__draft', text: 'これ全部Claudeが作った', media: ['/tmp/a.png'] } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'odorokiya-studio', surface, component: 'Pane', requestId: 'odorokiya-studio',
      props: { title: '驚き屋スタジオ', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 } } as never,
    })
    expect(await ui.find({ type: 'Text', text: /TL を開かずに/ })).toBeDefined()
    expect(await ui.find({ key: 'draft' })).toBeDefined()
    expect(await ui.find({ key: 'post' })).toBeDefined()
    if (surface === 'desktop') expect(await ui.find({ type: 'Svg' })).toBeDefined()
    await ui.unmount()
  }
})

test('本文を自分で入力したあとでも、AI 案の「これを使う」で入力欄が差し替わる', async ($, on) => {
  on('ui.render', () => h('Text', {}, 'engine'))
  on('ui.toast', () => ({ value: undefined }))
  on('model.fork', () => ({ value: { isAnswered: true, text: '["AIの案です"]', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }))
  const ui = await $.ui.mount({
    plugin: 'odorokiya-studio', surface: 'desktop', component: 'Pane', requestId: 'odorokiya-studio',
    props: { title: '驚き屋スタジオ', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 } } as never,
  })
  await ui.input({ key: 'body-0', text: '自分で書いた本文', kind: 'change' })
  await ui.press({ key: 'draft' })
  await ui.press({ key: 'use-0' })
  const field = await ui.find({ key: 'body-1' })
  expect(field).toBeDefined()
  expect(JSON.stringify(field)).toContain('AIの案です')
  await ui.unmount()
})

test('鍵は 4 つ揃ったときだけ環境変数として渡す', async () => {
  expect(credentialEnv({})).toEqual({})
  expect(credentialEnv({ x_api_key: 'a', x_api_secret: 'b', x_access_token: 'c' })).toEqual({})
  expect(credentialEnv({ x_api_key: 'a', x_api_secret: 'b', x_access_token: 'c', x_access_token_secret: ' d ' })).toEqual({
    ODOROKIYA_X_API_KEY: 'a', ODOROKIYA_X_API_SECRET: 'b', ODOROKIYA_X_ACCESS_TOKEN: 'c', ODOROKIYA_X_ACCESS_TOKEN_SECRET: 'd',
  })
})

test('未接続ならウィザードが出て、鍵は引数ではなく標準入力で渡る', async ($, on) => {
  const calls: Array<{ argv: readonly string[]; stdin?: string }> = []
  on('ui.render', () => h('Text', {}, 'engine'))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    calls.push({ argv: e.argv, stdin: e.init?.stdin })
    return { value: { exitCode: 0, stdout: '{"ok": true, "username": "demo_user"}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'odorokiya-studio', surface, component: 'Pane', requestId: 'odorokiya-studio',
      props: { title: '驚き屋スタジオ', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as never,
    })
    expect(await ui.find({ type: 'Text', text: /X とつなぐ/ })).toBeDefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount({
    plugin: 'odorokiya-studio', surface: 'desktop', component: 'Pane', requestId: 'odorokiya-studio',
    props: { title: '驚き屋スタジオ', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as never,
  })
  await ui.input({ key: 'k-consumer_key-0', text: 'KEY1234567890', kind: 'change' })
  await ui.input({ key: 'k-consumer_secret-0', text: 'SECRET1234567890', kind: 'change' })
  await ui.input({ key: 'k-access_token-0', text: 'TOKEN1234567890', kind: 'change' })
  await ui.input({ key: 'k-access_token_secret-0', text: 'TSECRET1234567890', kind: 'change' })
  await ui.press({ key: 'save-keys' })
  const save = calls.find(c => c.argv.includes('save-keys'))
  expect(save).toBeDefined()
  expect(save?.argv.join(' ')).not.toContain('KEY1234567890')
  expect(save?.stdin).toContain('KEY1234567890')
  expect(await ui.find({ type: 'Text', text: /X とつなぐ/ })).toBeUndefined()
  await ui.unmount()
})

test('鍵を読み出す Bash を見分ける', async () => {
  expect(isKeyAccess('security find-generic-password -s odorokiya-studio -a consumer_key -w')).toBe(true)
  expect(isKeyAccess('/usr/bin/security find-generic-password -s "x-post" -a access_token -w')).toBe(true)
  expect(isKeyAccess('security dump-keychain -d login.keychain')).toBe(true)
  expect(isKeyAccess('printenv ODOROKIYA_X_API_KEY')).toBe(true)
  expect(isKeyAccess('security find-generic-password -s other-app -w')).toBe(false)
  expect(isKeyAccess('git status')).toBe(false)
  expect(isKeyAccess('ls ~/Documents/GitHub/odorokiya-studio')).toBe(false)
})

test('Claude の Bash から鍵を読もうとすると止め、ほかのコマンドは通す', async ($, on) => {
  on('tool.call', () => ({ result: { stdout: 'ran', stderr: '', interrupted: false }, text: 'ran' }))
  const blocked = await $.tool.call({ tool: 'Bash', command: 'security find-generic-password -s odorokiya-studio -a consumer_key -w' } as never)
  expect(JSON.stringify(blocked)).toContain('驚き屋スタジオ')
  const passed = await $.tool.call({ tool: 'Bash', command: 'echo hi' } as never)
  expect(JSON.stringify(passed)).toContain('ran')
})

test('セキュリティの説明をコマンドで読める', async ($, on) => {
  on('fs.read', () => ({ value: '# 鍵の扱いとセキュリティ' }))
  const out = await $.command.run({ command: 'odorokiya-studio-security' } as never)
  expect(JSON.stringify(out)).toContain('鍵の扱いとセキュリティ')
})

test('一時フォルダの画像は素材として拾わない', async () => {
  expect(isTemporaryPath('/tmp/screen.png')).toBe(true)
  expect(isTemporaryPath('/private/tmp/claude-501/x/screenshot.png')).toBe(true)
  expect(isTemporaryPath('/var/folders/ab/T/shot.png')).toBe(true)
  expect(isTemporaryPath('/Users/me/project/demo.png')).toBe(false)
})
