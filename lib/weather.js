/**
 * dsh-astro-plan — 天气层（Open-Meteo 逐时预报 + 夜间评分）。
 *
 * 口径与 2026-11 全国方案的调研脚本一致：
 *   夜间窗口取 19:00–05:00（UTC+8），评分为
 *     0.6 × 整夜通透 + 0.4 × 最佳连续 3 小时窗口
 *   再扣降水概率、露点差（结露）、风速、能见度。
 *
 * 只在「今天 ~ 今天+7」内提供；更远日期返回 out_of_range。
 */

const API = 'https://api.open-meteo.com/v1/forecast'
const HOURLY = [
  'cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high',
  'precipitation_probability', 'relative_humidity_2m', 'dew_point_2m',
  'temperature_2m', 'wind_speed_10m', 'visibility',
].join(',')

const CACHE_TTL_MS = 10 * 60 * 1000
const cache = new Map() // key: siteId -> {at, data}

function cacheGet(siteId) {
  const hit = cache.get(siteId)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(siteId)
    return null
  }
  return hit.data
}

function isoDay(date) {
  return date.toISOString().slice(0, 10)
}

/** 天气覆盖范围：[今天, 今天+7]（UTC+8 口径）。 */
export function weatherCoverage(now = new Date()) {
  const local = new Date(now.getTime() + 8 * 3600 * 1000)
  const from = isoDay(local)
  const to = isoDay(new Date(local.getTime() + 7 * 86400000))
  return { from, to }
}

export function weatherAvailable(dateStr, now = new Date()) {
  const { from, to } = weatherCoverage(now)
  return dateStr >= from && dateStr <= to
}

async function fetchSite(site, tries = 3) {
  const cached = cacheGet(site.id)
  if (cached) return cached
  const { from, to } = weatherCoverage()
  const url = `${API}?latitude=${site.lat}&longitude=${site.lon}`
    + `&hourly=${encodeURIComponent(HOURLY)}`
    + `&start_date=${from}&end_date=${to}&timezone=Asia%2FShanghai`
  let lastError = null
  for (let i = 0; i < tries; i += 1) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 12000)
      const res = await fetch(url, { signal: controller.signal })
      clearTimeout(timer)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      if (!json?.hourly?.time) throw new Error('malformed weather payload')
      cache.set(site.id, { at: Date.now(), data: json })
      return json
    } catch (error) {
      lastError = error
      await new Promise((r) => setTimeout(r, 800 * (i + 1)))
    }
  }
  throw lastError ?? new Error('weather fetch failed')
}

function hoursFor(data, dateStr) {
  const times = data.hourly.time
  const next = new Date(new Date(`${dateStr}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10)
  const idx = []
  for (let i = 0; i < times.length; i += 1) {
    const [day, hm] = times[i].split('T')
    const hour = Number(hm.slice(0, 2))
    if (day === dateStr && hour >= 19) idx.push(i)
    else if (day === next && hour <= 5) idx.push(i)
  }
  return idx
}

/**
 * 单夜天气评分。
 * @returns {null | {status, score, cloudMean, clearHours, best3Start, best3Cloud,
 *   precipMax, dewGap, tMin, windMax, visKm, source}}
 */
export function scoreNight(data, dateStr) {
  const idx = hoursFor(data, dateStr)
  if (idx.length === 0) return null
  const H = data.hourly
  const low = idx.map((i) => H.cloud_cover_low[i] ?? 0)
  const mid = idx.map((i) => H.cloud_cover_mid[i] ?? 0)
  const high = idx.map((i) => H.cloud_cover_high[i] ?? 0)
  const total = idx.map((i) => H.cloud_cover[i] ?? 0)
  const precip = idx.map((i) => H.precipitation_probability[i] ?? 0)
  const temp = idx.map((i) => H.temperature_2m[i] ?? 0)
  const dew = idx.map((i) => H.dew_point_2m[i] ?? 0)
  const wind = idx.map((i) => H.wind_speed_10m[i] ?? 0)
  const vis = idx.map((i) => H.visibility[i] ?? 20000)

  const weighted = low.map((l, i) => 0.5 * l + 0.3 * mid[i] + 0.2 * high[i])
  const mean = weighted.reduce((a, b) => a + b, 0) / weighted.length
  const clearHours = total.filter((c) => c < 25).length

  let best = 1e9
  let bestStart = idx[0]
  for (let i = 0; i + 2 < weighted.length; i += 1) {
    const m = (weighted[i] + weighted[i + 1] + weighted[i + 2]) / 3
    if (m < best) { best = m; bestStart = idx[i] }
  }

  const precipMax = Math.max(...precip)
  const dewGap = Math.min(...temp.map((t, i) => t - dew[i]))
  const windMax = Math.max(...wind)
  const visKm = vis.reduce((a, b) => a + b, 0) / vis.length / 1000

  let score = 0.6 * (100 - mean) + 0.4 * (100 - best)
  if (precipMax >= 50) score -= 15
  else if (precipMax >= 25) score -= 6
  if (dewGap < 2) score -= 8
  else if (dewGap < 4) score -= 4
  if (windMax > 40) score -= 8
  else if (windMax > 28) score -= 4
  if (visKm < 12) score -= 4
  score = Math.max(0, Math.min(100, score))

  return {
    status: 'ok',
    score: Math.round(score),
    cloudMean: Math.round(mean),
    clearHours,
    best3Start: H.time[bestStart].slice(11, 16),
    best3Cloud: Math.round(best),
    precipMax,
    dewGap: Math.round(dewGap * 10) / 10,
    tMin: Math.round(Math.min(...temp) * 10) / 10,
    windMax: Math.round(windMax),
    visKm: Math.round(visKm),
    source: 'open-meteo',
  }
}

/**
 * 取一个站点指定日期的夜间天气评分。
 * @returns {Promise<object>} 永远 resolve；不可用时 status 标明原因
 */
export async function nightWeather(site, dateStr, now = new Date()) {
  if (!weatherAvailable(dateStr, now)) {
    return { status: 'out_of_range', score: null, source: 'open-meteo' }
  }
  try {
    const data = await fetchSite(site)
    const scored = scoreNight(data, dateStr)
    return scored ?? { status: 'no_data', score: null, source: 'open-meteo' }
  } catch (error) {
    return { status: 'unavailable', score: null, source: 'open-meteo', error: String(error?.message ?? error) }
  }
}

/**
 * 指定小时内的小时下标（用于日食这类白天事件）。
 * @param {string} fromHM "HH:MM"，包含
 * @param {string} toHM   "HH:MM"，包含
 */
function hoursInWindow(data, dateStr, fromHM, toHM) {
  const times = data.hourly.time
  const from = Number(String(fromHM).slice(0, 2))
  const to = Number(String(toHM).slice(0, 2))
  const lo = Math.min(from, to)
  const hi = Math.max(from, to)
  const idx = []
  for (let i = 0; i < times.length; i += 1) {
    const [day, hm] = times[i].split('T')
    if (day !== dateStr) continue
    const hour = Number(hm.slice(0, 2))
    if (hour >= lo && hour <= hi) idx.push(i)
  }
  return idx
}

/**
 * 白天窗口天气评分（日食用）。字段与 scoreNight 保持一致，便于 UI/工具复用。
 */
export function scoreDaytime(data, dateStr, fromHM, toHM) {
  const idx = hoursInWindow(data, dateStr, fromHM, toHM)
  if (idx.length === 0) return null
  const H = data.hourly
  const low = idx.map((i) => H.cloud_cover_low[i] ?? 0)
  const mid = idx.map((i) => H.cloud_cover_mid[i] ?? 0)
  const high = idx.map((i) => H.cloud_cover_high[i] ?? 0)
  const total = idx.map((i) => H.cloud_cover[i] ?? 0)
  const precip = idx.map((i) => H.precipitation_probability[i] ?? 0)
  const temp = idx.map((i) => H.temperature_2m[i] ?? 0)
  const dew = idx.map((i) => H.dew_point_2m[i] ?? 0)
  const wind = idx.map((i) => H.wind_speed_10m[i] ?? 0)
  const vis = idx.map((i) => H.visibility[i] ?? 20000)

  const weighted = low.map((l, i) => 0.5 * l + 0.3 * mid[i] + 0.2 * high[i])
  const mean = weighted.reduce((a, b) => a + b, 0) / weighted.length
  const worst = Math.max(...weighted)
  const clearHours = total.filter((c) => c < 25).length
  const bestIdx = weighted.indexOf(Math.min(...weighted))

  const precipMax = Math.max(...precip)
  const dewGap = Math.min(...temp.map((t, i) => t - dew[i]))
  const windMax = Math.max(...wind)
  const visKm = vis.reduce((a, b) => a + b, 0) / vis.length / 1000

  let score = 0.7 * (100 - mean) + 0.3 * (100 - worst)
  if (precipMax >= 50) score -= 15
  else if (precipMax >= 25) score -= 6
  if (windMax > 40) score -= 8
  else if (windMax > 28) score -= 4
  if (visKm < 12) score -= 4
  score = Math.max(0, Math.min(100, score))

  return {
    status: 'ok',
    score: Math.round(score),
    cloudMean: Math.round(mean),
    clearHours,
    best3Start: H.time[idx[bestIdx]].slice(11, 16),
    best3Cloud: Math.round(weighted[bestIdx]),
    precipMax,
    dewGap: Math.round(dewGap * 10) / 10,
    tMin: Math.round(Math.min(...temp) * 10) / 10,
    windMax: Math.round(windMax),
    visKm: Math.round(visKm),
    source: 'open-meteo',
    daytime: true,
  }
}

/**
 * 取一个站点指定日期、指定时段（本地时间）的白天天气评分。
 * @returns {Promise<object>} 永远 resolve
 */
export async function dayWeather(site, dateStr, fromHM, toHM, now = new Date()) {
  if (!weatherAvailable(dateStr, now)) {
    return { status: 'out_of_range', score: null, source: 'open-meteo' }
  }
  try {
    const data = await fetchSite(site)
    const scored = scoreDaytime(data, dateStr, fromHM, toHM)
    return scored ?? { status: 'no_data', score: null, source: 'open-meteo' }
  } catch (error) {
    return { status: 'unavailable', score: null, source: 'open-meteo', error: String(error?.message ?? error) }
  }
}

/** 批量取多站点同夜天气（并发 4）。 */
export async function batchNightWeather(sites, dateStr, now = new Date()) {
  const out = new Map()
  const queue = [...sites]
  async function worker() {
    while (queue.length > 0) {
      const site = queue.shift()
      out.set(site.id, await nightWeather(site, dateStr, now))
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, sites.length) }, worker))
  return out
}

export function clearWeatherCache() {
  cache.clear()
}
