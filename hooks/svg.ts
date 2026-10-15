// 驚き屋スタジオの desktop 用ビジュアル部品。すべて純関数で SVG 文字列を返す。
// desktop は Svg を画像として描くので、写真は data URI で埋め込む(外部参照は描かれない)。
import type { OdorokiyaMedia } from '../types'

export const ACCENT = '#D97757'
const HAIRLINE = 'rgba(127,127,127,0.28)'
const PLACEHOLDER = 'rgba(127,127,127,0.14)'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`

const svg = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`

// 1枚分の写真(または代わりの面)を矩形に cover で敷く
const photo = (m: OdorokiyaMedia, x: number, y: number, w: number, h: number, clip: string) => {
  const fill = m.thumb
    ? `<image href="data:image/jpeg;base64,${m.thumb}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clip})"/>`
    : `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${PLACEHOLDER}" clip-path="url(#${clip})"/>` +
      `<text x="${x + w / 2}" y="${y + h / 2 + 4}" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="11" fill="rgba(127,127,127,0.9)">${esc(m.kind.toUpperCase())}</text>`
  if (m.kind === 'image') return fill
  // 動画・GIF: 下に陰影、中央に再生マーク、右下に長さ/GIF
  const cx = x + w / 2
  const cy = y + h / 2
  const r = Math.max(10, Math.min(w, h) * 0.14)
  const badge = m.kind === 'gif' ? 'GIF' : m.duration != null ? clock(m.duration) : ''
  const shade = `<rect x="${x}" y="${y + h * 0.55}" width="${w}" height="${h * 0.45}" fill="url(#shade)" clip-path="url(#${clip})"/>`
  const play =
    m.kind === 'video'
      ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="rgba(0,0,0,0.45)" stroke="rgba(255,255,255,0.85)" stroke-width="1.5"/>` +
        `<path d="M${cx - r * 0.32} ${cy - r * 0.45} L${cx + r * 0.5} ${cy} L${cx - r * 0.32} ${cy + r * 0.45} Z" fill="#fff"/>`
      : ''
  const label = badge
    ? `<rect x="${x + w - 8 - badge.length * 7 - 8}" y="${y + h - 26}" rx="4" width="${badge.length * 7 + 8}" height="18" fill="rgba(0,0,0,0.6)"/>` +
      `<text x="${x + w - 12}" y="${y + h - 13}" text-anchor="end" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="11" font-weight="600" fill="#fff">${badge}</text>`
    : ''
  return fill + shade + play + label
}

const defs = (clips: string) =>
  `<defs><linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.45"/></linearGradient>${clips}</defs>`

// 素材ギャラリーの1マス。選択中はアクセント色のリングと番号バッジ。
export const thumbSvg = (m: OdorokiyaMedia, order: number | undefined, size = 92): string => {
  const pad = 3
  const inner = size - pad * 2
  const rx = 10
  const clip = `<clipPath id="c"><rect x="${pad}" y="${pad}" width="${inner}" height="${inner}" rx="${rx - 2}"/></clipPath>`
  const ring =
    order !== undefined
      ? `<rect x="1.5" y="1.5" width="${size - 3}" height="${size - 3}" rx="${rx + 1}" fill="none" stroke="${ACCENT}" stroke-width="3"/>` +
        `<circle cx="${size - 15}" cy="15" r="10" fill="${ACCENT}" stroke="#fff" stroke-width="1.5"/>` +
        `<text x="${size - 15}" y="19" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="12" font-weight="700" fill="#fff">${order}</text>`
      : `<rect x="${pad + 0.5}" y="${pad + 0.5}" width="${inner - 1}" height="${inner - 1}" rx="${rx - 2}" fill="none" stroke="${HAIRLINE}"/>`
  return svg(size, size, defs(clip) + photo(m, pad, pad, inner, inner, 'c') + ring)
}

// 投稿プレビューのメディア枠。X と同じ割り付け(1枚 / 2分割 / 左大+右2 / 2x2)。
export const mediaGridSvg = (items: readonly OdorokiyaMedia[], width: number): string => {
  const n = Math.min(items.length, 4)
  if (n === 0) return ''
  const first = items[0]
  const ratio = n === 1 && first && first.width && first.height ? Math.min(1.25, Math.max(0.5625, first.height / first.width)) : 0.5625
  const h = Math.round(width * ratio)
  const g = 2
  const half = (width - g) / 2
  const halfH = (h - g) / 2
  const cells: Array<[number, number, number, number]> =
    n === 1 ? [[0, 0, width, h]]
      : n === 2 ? [[0, 0, half, h], [half + g, 0, half, h]]
        : n === 3 ? [[0, 0, half, h], [half + g, 0, half, halfH], [half + g, halfH + g, half, halfH]]
          : [[0, 0, half, halfH], [half + g, 0, half, halfH], [0, halfH + g, half, halfH], [half + g, halfH + g, half, halfH]]
  const clips =
    `<clipPath id="frame"><rect width="${width}" height="${h}" rx="14"/></clipPath>` +
    cells.map(([x, y, w, hh], i) => `<clipPath id="g${i}"><rect x="${x}" y="${y}" width="${w}" height="${hh}"/></clipPath>`).join('')
  const body = cells.map(([x, y, w, hh], i) => {
    const m = items[i]
    return m ? photo(m, x, y, w, hh, `g${i}`) : ''
  }).join('')
  return svg(width, h, defs(clips) + `<g clip-path="url(#frame)">${body}</g>` +
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${h - 1}" rx="14" fill="none" stroke="${HAIRLINE}"/>`)
}

// X の投稿画面と同じ、残り文字数のリング
export const counterSvg = (count: number, limit: number): string => {
  const size = 26
  const r = 10
  const c = 2 * Math.PI * r
  const ratio = Math.min(1, count / limit)
  const rest = limit - count
  const color = rest < 0 ? '#E5484D' : rest <= 20 ? '#E5A000' : ACCENT
  const arc = `<circle cx="13" cy="13" r="${r}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="${(c * ratio).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 13 13)"/>`
  const label = rest <= 20
    ? `<text x="13" y="17" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="${rest <= -100 ? 8 : 10}" font-weight="600" fill="${color}">${rest}</text>`
    : ''
  return svg(size, size, `<circle cx="13" cy="13" r="${r}" fill="none" stroke="${HAIRLINE}" stroke-width="2.5"/>` + (count > 0 ? arc : '') + label)
}

// 帯に出す小さなサムネイル
export const chipSvg = (m: OdorokiyaMedia, size = 30): string => {
  const clip = `<clipPath id="k"><rect width="${size}" height="${size}" rx="7"/></clipPath>`
  return svg(size, size, defs(clip) + photo({ ...m, kind: 'image' }, 0, 0, size, size, 'k') +
    `<rect x="0.5" y="0.5" width="${size - 1}" height="${size - 1}" rx="7" fill="none" stroke="${HAIRLINE}"/>`)
}
