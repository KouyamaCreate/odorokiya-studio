export type OdorokiyaMedia = {
  path: string
  name: string
  kind: 'image' | 'gif' | 'video'
  size: number
  at: number
  /** 200px の JPEG サムネイル(base64)。作れなかったときは無し */
  thumb?: string
  w?: number
  h?: number
  /** 動画の長さ(秒) */
  duration?: number | null
}
export type OdorokiyaKeyName = 'consumer_key' | 'consumer_secret' | 'access_token' | 'access_token_secret'
export type OdorokiyaSetup = { message: string; isError: boolean } | null

export type OdorokiyaStatus =
  | { kind: 'idle' }
  | { kind: 'posting' }
  | { kind: 'done'; url: string }
  | { kind: 'error'; message: string; code?: string }

declare module 'claude-code' {
  interface PluginState {
    'odorokiya-studio': {
      media: OdorokiyaMedia[]
      selected: string[]
      text: string
      status: OdorokiyaStatus
      account: string
      isBandHidden: boolean
      candidates: string[]
      busy: '' | 'draft' | 'polish'
      showAll: boolean
      /** 本文をパネルの外から差し替えた回数。入力欄を作り直して新しい本文を反映させる */
      bodyRev: number
      /** X とつなぐウィザードを開いているか(未接続のときは常に出す) */
      setupOpen: boolean
      /** ウィザードで鍵が入っている欄の数。鍵そのものは state に置かない(他のプラグインから読めるため) */
      keyFilled: number
      /** パネルでセキュリティの説明を開いているか */
      showSecurity: boolean
      keyRev: number
      setupNote: OdorokiyaSetup
      setupBusy: boolean
    }
  }
}
