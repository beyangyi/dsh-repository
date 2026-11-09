/**
 * dsh-astro-plan — 极光可见性判据。
 *
 * 国内只有北纬 42° 以上的站点在强地磁暴时可能看到极光，仅靠「季节 + 站点纬度」
 * 会给出永远可拍的假结果（此前每次查询都固定 3 条）。这里用两件事判可见性：
 *   1. 站点地磁纬度（偶极近似，地磁北极 80.65°N / 72.68°W）；
 *   2. NOAA SWPC 的 Kp 预报（3 小时分辨率，含观测 + 未来约 3 天预测）。
 * Kp 达不到所需阈值 → 该站该夜不产生结果；预报没覆盖到的日期 → 不产生结果，
 * 由 planner 给出「超出 Kp 预报范围」的说明。
 */

const KP_URL = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json'
const CACHE_TTL_MS = 30 * 60 * 1000
const D2R = Math.PI / 180
const R2D = 180 / Math.PI

/** 地磁北极（IGRF 近似，2020 年代）。 */
const MAG_POLE = { lat: 80.65, lon: -72.68 }

let cache = { at: 0, data: null }

/** 站点纬经度 → 地磁纬度（度）。 */
export function geomagneticLatitude(lat, lon) {
  const p = MAG_POLE.lat * D2R
  const l0 = MAG_POLE.lon * D2R
  const phi = lat * D2R
  const lambda = lon * D2R
  const sinM = Math.sin(phi) * Math.sin(p) + Math.cos(phi) * Math.cos(p) * Math.cos(lambda - l0)
  return Math.asin(Math.max(-1, Math.min(1, sinM))) * R2D
}

/**
 * 该站看到极光所需的最低 Kp。
 * 经验式：极光卵赤道侧边界随 Kp 下降约 3°/级，Kp 0 ≈ 66.5° 地磁纬度。
 * 漠河（地磁纬度 ~46°）需要 Kp ≥ 6.8；长白山（~40°）需要 Kp ≥ 8.8。
 */
export function requiredKp(magLat) {
  return Math.max(0, Math.min(9, (66.5 - magLat) / 3))
}

function parseRows(rows) {
  const out = []
  for (const row of rows) {
    const iso = String(row.time_tag ?? '').replace(' ', 'T')
    const kp = Number(row.kp)
    if (!iso || !Number.isFinite(kp)) continue
    const time = new Date(`${iso}Z`)
    if (Number.isNaN(time.getTime())) continue
    out.push({ time, kp })
  }
  return out.sort((a, b) => a.time - b.time)
}

/**
 * 取 Kp 序列（30 分钟缓存）。失败返回 null，调用方据此判定「无法确认」。
 */
export async function kpForecast() {
  if (cache.data && Date.now() - cache.at < CACHE_TTL_MS) return cache.data
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12000)
    const res = await fetch(KP_URL, { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const rows = await res.json()
    const data = parseRows(Array.isArray(rows) ? rows : [])
    if (data.length === 0) throw new Error('empty kp payload')
    cache = { at: Date.now(), data }
    return data
  } catch (error) {
    return null
  }
}

/**
 * 每个「夜」（D 15:00 → D+1 09:00，UTC+8）的 Kp 峰值。
 * 对应 UTC 窗口 D 07:00 → D+1 01:00。
 * @returns {Map<string, number>}
 */
export function kpByNight(forecast) {
  const map = new Map()
  if (!forecast) return map
  for (const { time, kp } of forecast) {
    // 夜 D（UTC+8 15:00 → 次日 09:00）= UTC D 07:00 → D+1 01:00
    const utcHour = time.getUTCHours()
    let dateKey
    if (utcHour >= 7) dateKey = time.toISOString().slice(0, 10)
    else if (utcHour <= 1) dateKey = new Date(time.getTime() - 86400000).toISOString().slice(0, 10)
    else continue
    const prev = map.get(dateKey)
    if (prev === undefined || kp > prev) map.set(dateKey, kp)
  }
  return map
}

/** 预报覆盖的日期范围（给提示用）。 */
export function kpCoverage(forecast) {
  if (!forecast || forecast.length === 0) return { from: null, to: null }
  const first = forecast[0].time.toISOString().slice(0, 10)
  const last = forecast[forecast.length - 1].time.toISOString().slice(0, 10)
  return { from: first, to: last }
}

export function clearAuroraCache() {
  cache = { at: 0, data: null }
}
