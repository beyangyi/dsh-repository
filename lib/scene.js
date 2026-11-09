/**
 * dsh-astro-plan — 地景建模（画面模拟用）。
 *
 * 天际线来自**真实高程数据**：tools/build-horizon.mjs 沿每个站点 36 个方位采样
 * AWS Open Data 地形瓦片（terrarium z8，约 600 m 像元）在 1.5–140 km 上的地面高程，
 * 换算成视线仰角（含地球曲率与大气折射），按距离分成两层存进 data/horizon.json：
 *   near（1.5–25 km）= 挡住地平线的近处山脊 / 林带 / 楼群；
 *   far（25–140 km） = 能露出来的远山。
 * 观测点高度取「站点实测海拔」与「瓦片在站点处的读数」的高者：
 * 山峰类站点的坐标就落在山顶上，取低值会把整圈地形算成一口井。
 * 没有高程记录的站点退回「站点实测海拔 + 周边站点海拔中位数」的粗估。
 *
 * 地景名关键字只决定剪影的**类型**（山峰 / 林线 / 水面 / 建筑…），不再决定高度，
 * 所以画面上不会再出现凭空的三角形尖。天球投影与逐帧场景在 lib/skyview.js。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SITES, distanceKm } from './catalog.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const D2R = Math.PI / 180
const R2D = 180 / Math.PI

function loadJson(name) {
  try {
    return JSON.parse(readFileSync(join(HERE, 'data', name), 'utf8'))
  } catch {
    return null
  }
}

const MODELS = loadJson('foreground-models.json')
  ?? { rules: [], default: { kind: 'ridge', heightDeg: 5, jag: 0.18 } }
const HORIZON = loadJson('horizon.json')

/** 高程库概况（README / meta 用）。 */
export const HORIZON_INFO = HORIZON
  ? {
    source: HORIZON.source,
    generated: HORIZON.generated,
    step: HORIZON.step,
    sites: Object.keys(HORIZON.sites ?? {}).length,
    distancesKm: HORIZON.distancesKm,
  }
  : null

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/** 地景名 → { kind, heightDeg, jag }（按规则表顺序匹配，先命中者生效）。 */
export function classifyForeground(name) {
  const text = String(name ?? '')
  for (const rule of MODELS.rules ?? []) {
    if ((rule.match ?? []).some((k) => text.includes(k))) {
      return { kind: rule.kind, heightDeg: rule.heightDeg, jag: rule.jag }
    }
  }
  const d = MODELS.default ?? { kind: 'ridge', heightDeg: 5, jag: 0.18 }
  return { kind: d.kind, heightDeg: d.heightDeg, jag: d.jag }
}

/** 方位窗口宽度（度）：0-360 记作整圈。 */
function azSpanOf(fg) {
  const span = (((Number(fg.azTo) - Number(fg.azFrom)) % 360) + 360) % 360
  return span === 0 ? 360 : span
}

/** 站点是否有实测高程剖面。 */
export function hasHorizon(site) {
  const rec = HORIZON?.sites?.[site?.id]
  return Boolean(rec && Array.isArray(rec.n) && rec.n.length > 0)
}

/** 站点整圈剖面原始记录 { n: [...], f: [...] }（36 点，10° 步长）。 */
export function horizonProfile(site) {
  return hasHorizon(site) ? HORIZON.sites[site.id] : null
}

/** 剖面数组按方位线性插值（环绕）。 */
function sampleProfile(arr, az, step) {
  if (!Array.isArray(arr) || !arr.length) return 0
  const a = ((Number(az) % 360) + 360) % 360
  const idx = a / step
  const i0 = Math.floor(idx) % arr.length
  const i1 = (i0 + 1) % arr.length
  const t = idx - Math.floor(idx)
  return arr[i0] * (1 - t) + arr[i1] * t
}

/** 真实地平线高度（度）：近景与远景两层取高者。 */
export function horizonLine(site, az) {
  const p = horizonProfile(site)
  if (!p) return null
  const step = HORIZON.step || 10
  return Math.max(sampleProfile(p.n, az, step), sampleProfile(p.f, az, step))
}

function median(values) {
  if (!values.length) return 0
  const arr = [...values].sort((a, b) => a - b)
  const mid = arr.length >> 1
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2
}

/**
 * 没有高程记录时的粗估：站点海拔与 150 km 内其他站点海拔中位数的差 → 地平线抬升。
 * 有高程记录时只作为 `reliefDeg` 的兜底值。
 */
export function reliefDeg(site) {
  const alt = Number(site?.altM)
  if (!Number.isFinite(alt)) return 4
  const near = SITES.filter((o) => o.id !== site.id
    && distanceKm(site.lat, site.lon, o.lat, o.lon) <= 150)
  if (near.length < 3) return 4
  const diff = median(near.map((o) => Number(o.altM) || 0)) - alt
  if (diff > 0) return clamp(Math.atan(diff / 15000) * R2D * 1.6, 1.5, 13)
  return clamp(1.2 + Math.atan(-diff / 30000) * R2D * 0.8, 1.2, 6)
}

/** 站点地景 → 一条条剪影的类型与方位窗口（高度优先取实测剖面）。 */
export function foregroundModels(site) {
  const prior = reliefDeg(site)
  const prof = horizonProfile(site)
  const step = HORIZON?.step || 10
  return (site?.foregrounds ?? []).map((fg) => {
    const width = azSpanOf(fg)
    const model = classifyForeground(fg.name)
    const centerAz = ((Number(fg.azFrom) + width / 2) % 360 + 360) % 360
    let measured = null
    if (prof) {
      // 窗口内实测地平线的最高点
      let best = -90
      for (let a = 0; a < 360; a += Math.min(2, step)) {
        if (width >= 359.5 || Math.abs(((a - centerAz + 540) % 360) - 180) <= width / 2) {
          best = Math.max(best, sampleProfile(prof.n, a, step), sampleProfile(prof.f, a, step))
        }
      }
      measured = Math.round(clamp(best, -6, 45) * 10) / 10
    }
    return {
      name: fg.name,
      azFrom: fg.azFrom,
      azTo: fg.azTo,
      width,
      centerAz,
      ...model,
      reliefDeg: Math.round(prior * 10) / 10,
      measured,
      heightDeg: measured != null
        ? Math.max(0.2, measured)
        : Math.round(clamp(prior * 0.6 + model.heightDeg * 0.4, 1.5, 15) * 10) / 10,
    }
  })
}

/** 站点 id → 0–10 的确定性相位（同一站点每次都一样；仅兜底剪影用）。 */
export function seedOf(site) {
  let h = 0
  for (const ch of String(site?.id ?? '')) h = (h * 31 + ch.charCodeAt(0)) % 10007
  return (h % 1000) / 100
}

/** 兜底：某方位上的地形剪影高度（度）；窗口外为 0，边界外沿 2° 内线性过渡。 */
export function horizonAt(models, az, seed = 0) {
  const a = ((Number(az) % 360) + 360) % 360
  let best = 0
  for (const m of models ?? []) {
    const diff = Math.abs(((a - m.centerAz + 540) % 360) - 180)
    const half = m.width / 2
    let weight = 0
    if (diff <= half) weight = 1
    else if (diff <= half + 2) weight = 1 - (diff - half) / 2
    if (weight <= 0) continue
    const h = m.heightDeg
      * (1 + m.jag * (Math.sin(a * 3.1 + seed) + 0.5 * Math.sin(a * 7.7 + seed * 2)))
    best = Math.max(best, Math.max(0, h) * weight)
  }
  return clamp(best, 0, 18)
}

/** 地景类型 → 渲染用的数字编码（渲染器按它画不同轮廓）。 */
export const KIND_CODE = { ridge: 0, forest: 1, water: 2, meadow: 3, structure: 4, desert: 5 }

/** 某方位命中的地景类型码（窗口内取窗口最宽的那条）。 */
function kindAt(models, az) {
  let kind = 0
  let bestW = 0
  for (const m of models) {
    const diff = Math.abs(((az - m.centerAz + 540) % 360) - 180)
    const half = m.width / 2
    if (diff > half + 2) continue
    if (m.width > bestW) { bestW = m.width; kind = KIND_CODE[m.kind] ?? 0 }
  }
  return kind
}

/**
 * 生成整圈天际线：近景 + 远景，每点 [方位°, 高度°, 类型码]。
 * - 有高程记录：高度直接取实测剖面（near 0.8–20 km / far 40–140 km），
 *   只按 1° 步长线性插值，不加任何人工起伏；
 * - 无高程记录：退回「站点海拔先验 + 地景名」的平滑兜底剪影。
 */
export function skyline(site, stepDeg = 1) {
  const models = foregroundModels(site)
  const prof = horizonProfile(site)
  const step = HORIZON?.step || 10
  const seed = seedOf(site)
  const fallbackRelief = reliefDeg(site)
  const near = []
  const far = []
  const n = Math.round(360 / stepDeg)
  let maxNear = -90
  for (let i = 0; i < n; i += 1) {
    const az = Math.round((i * stepDeg) * 10) / 10
    const kind = kindAt(models, az)
    let alt
    let farAlt
    if (prof) {
      alt = sampleProfile(prof.n, az, step)
      farAlt = sampleProfile(prof.f, az, step)
    } else {
      const base = horizonAt(models, az, seed) || fallbackRelief * 0.4
      const s = az * D2R
      // 兜底剪影也保持平滑：只用低频起伏，不画尖峰
      alt = base * (1 + 0.12 * Math.sin(s * 2.3 + seed))
      farAlt = base * 0.62 * (1 + 0.05 * Math.sin(s * 5.3 + seed + 1.7))
    }
    maxNear = Math.max(maxNear, alt)
    near.push([az, Math.round(clamp(alt, -6, 45) * 10) / 10, kind])
    far.push([az, Math.round(clamp(farAlt, -6, 45) * 10) / 10, kind])
  }
  return {
    near,
    far,
    relief: Math.round(clamp(Math.max(0.4, maxNear), 0.4, 45) * 10) / 10,
    models,
    source: prof ? 'dem' : 'prior',
  }
}

export { D2R, R2D }
