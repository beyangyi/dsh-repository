/**
 * dsh-astro-plan — 天气层（多源：MET Norway / Open-Meteo / 7Timer）。
 *
 * 口径与 2026-11 全国方案的调研脚本一致：
 *   夜间窗口取 19:00–05:00（UTC+8），评分为
 *     0.6 × 整夜通透 + 0.4 × 最佳连续 3 小时窗口
 *   再扣降水概率、露点差（结露）、风速、能见度。
 *
 * 多源策略：按「MET Norway → Open-Meteo → 7Timer」顺序尝试，单源 4 秒超时、
 * 整轮 12 秒预算；某源失败即熔断（本次查询不再用），下一个源继续。
 * 每个源都归一化成 Open-Meteo 形状的 hourly 列，评分逻辑只有一份。
 */

import * as metno from './weather/sources/metno.js'
import * as openmeteo from './weather/sources/openmeteo.js'
import * as timer7 from './weather/sources/timer7.js'

/** 优先级顺序：先快的、免 key 的全球源，再批量全字段源，最后天文保底源。 */
const SOURCES = [metno, openmeteo, timer7]
const SOURCE_BY_ID = new Map(SOURCES.map((source) => [source.id, source]))

const CACHE_TTL_MS = 10 * 60 * 1000
const PER_SOURCE_MS = 4000
const TOTAL_BUDGET_MS = 12000

const cache = new Map() // `${sourceId}:${siteId}` -> { at, data }
const down = new Set() // 本次查询中已失败的源
let chosen = null // 本轮选中的源（module 级，查询开始时重置）

export function resetWeatherBreaker() {
  down.clear()
  chosen = null
}
export function weatherBreakerOpen() {
  return SOURCES.every((source) => down.has(source.id))
}
export function resetWeatherCache() {
  cache.clear()
}
export const clearWeatherCache = resetWeatherCache
/** 本轮实际使用的天气源名（给备注/便签用）。 */
export function weatherSourceName() {
  return chosen?.name ?? null
}

function isoDay(date) {
  return date.toISOString().slice(0, 10)
}

/** 天气覆盖范围：[今天, 今天+7]（UTC+8 口径）。 */
export function weatherCoverage(now = new Date()) {
  const local = new Date(now.getTime() + 8 * 3600 * 1000)
  return { from: isoDay(local), to: isoDay(new Date(local.getTime() + 7 * 86400000)) }
}

export function weatherAvailable(dateStr, now = new Date()) {
  const { from, to } = weatherCoverage(now)
  return dateStr >= from && dateStr <= to
}

function cacheGet(sourceId, siteId) {
  const hit = cache.get(`${sourceId}:${siteId}`)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(`${sourceId}:${siteId}`)
    return null
  }
  return hit.data
}

/**
 * 预热天气缓存：按源顺序尝试，够 60% 站点成功就采用该源。
 * @returns {Promise<boolean>} 是否拿到可用天气
 */
export async function primeWeather(sites) {
  if (!sites.length) return false
  if (chosen) return true
  const days = weatherCoverage()
  const entryDeadline = Date.now() + TOTAL_BUDGET_MS

  for (const source of SOURCES) {
    if (down.has(source.id)) continue
    if (sites.every((site) => cacheGet(source.id, site.id))) {
      chosen = source
      return true
    }
    if (Date.now() > entryDeadline - 800) break
    const deadline = Math.min(Date.now() + PER_SOURCE_MS, entryDeadline)
    let fetched = new Map()
    try {
      fetched = await source.fetchSites(sites.map((site) => ({ ...site })), { ...days, deadline })
    } catch {
      fetched = new Map()
    }
    const at = Date.now()
    for (const [siteId, data] of fetched) cache.set(`${source.id}:${siteId}`, { at, data })
    if (fetched.size >= Math.ceil(sites.length * 0.6)) {
      chosen = source
      return true
    }
    down.add(source.id)
  }
  return false
}

/** 单站取数：优先本轮选中的源，其次按顺序试其他源。 */
async function fetchSite(site) {
  const ordered = chosen ? [chosen, ...SOURCES.filter((source) => source !== chosen)] : SOURCES
  for (const source of ordered) {
    const cached = cacheGet(source.id, site.id)
    if (cached) return cached
    if (down.has(source.id)) continue
    const days = { ...weatherCoverage(), deadline: Date.now() + PER_SOURCE_MS }
    try {
      const fetched = await source.fetchSites([{ ...site }], days)
      const data = fetched.get(site.id)
      if (data) {
        cache.set(`${source.id}:${site.id}`, { at: Date.now(), data })
        if (!chosen) chosen = source
        return data
      }
    } catch {
      /* 落到下一个源 */
    }
    down.add(source.id)
  }
  throw new Error('no weather source available')
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

function hoursInWindow(data, dateStr, fromHM, toHM) {
  const times = data.hourly.time
  const lo = Math.min(Number(String(fromHM).slice(0, 2)), Number(String(toHM).slice(0, 2)))
  const hi = Math.max(Number(String(fromHM).slice(0, 2)), Number(String(toHM).slice(0, 2)))
  const idx = []
  for (let i = 0; i < times.length; i += 1) {
    const [day, hm] = times[i].split('T')
    if (day !== dateStr) continue
    const hour = Number(hm.slice(0, 2))
    if (hour >= lo && hour <= hi) idx.push(i)
  }
  return idx
}

const valueOr = (array, index, fallback) => {
  const value = array?.[index]
  return value === null || value === undefined || Number.isNaN(value) ? fallback : value
}
const has = (array, index) => {
  const value = array?.[index]
  return value !== null && value !== undefined && !Number.isNaN(value)
}

/** 逐小时的通透度：有分层云量就用加权，没有就用总云量。 */
function cloudSeries(H, idx) {
  return idx.map((i) => {
    const total = valueOr(H.cloud_cover, i, 0)
    if (!has(H.cloud_cover_low, i) && !has(H.cloud_cover_mid, i) && !has(H.cloud_cover_high, i)) return total
    return 0.5 * valueOr(H.cloud_cover_low, i, total)
      + 0.3 * valueOr(H.cloud_cover_mid, i, total)
      + 0.2 * valueOr(H.cloud_cover_high, i, total)
  })
}

function precipSeries(H, idx) {
  return idx.map((i) => {
    if (has(H.precipitation_probability, i)) return valueOr(H.precipitation_probability, i, 0)
    return 0
  })
}

/** 露点差（温度 − 露点）；缺露点则该夜不扣结露分。 */
function dewGapOf(H, idx) {
  let min = Infinity
  idx.forEach((i) => {
    if (!has(H.temperature_2m, i) || !has(H.dew_point_2m, i)) return
    min = Math.min(min, valueOr(H.temperature_2m, i, 0) - valueOr(H.dew_point_2m, i, 0))
  })
  return Number.isFinite(min) ? min : null
}

function visKmOf(H, idx) {
  const values = idx.filter((i) => has(H.visibility, i)).map((i) => valueOr(H.visibility, i, 20000))
  if (!values.length) return null
  return values.reduce((a, b) => a + b, 0) / values.length / 1000
}

function windMaxOf(H, idx) {
  const values = idx.filter((i) => has(H.wind_speed_10m, i)).map((i) => valueOr(H.wind_speed_10m, i, 0))
  return values.length ? Math.max(...values) : null
}

function tempMinOf(H, idx) {
  const values = idx.filter((i) => has(H.temperature_2m, i)).map((i) => valueOr(H.temperature_2m, i, 0))
  return values.length ? Math.min(...values) : null
}

/** 单夜天气评分（19:00–05:00）。 */
export function scoreNight(data, dateStr) {
  const idx = hoursFor(data, dateStr)
  if (idx.length === 0) return null
  const H = data.hourly
  const weighted = cloudSeries(H, idx)
  const mean = weighted.reduce((a, b) => a + b, 0) / weighted.length
  const clearHours = weighted.filter((c) => c < 25).length

  let best = 1e9
  let bestAt = 0
  for (let i = 0; i + 2 < weighted.length; i += 1) {
    const m = (weighted[i] + weighted[i + 1] + weighted[i + 2]) / 3
    if (m < best) { best = m; bestAt = i }
  }

  const precipMax = Math.max(...precipSeries(H, idx))
  const dewGap = dewGapOf(H, idx)
  const windMax = windMaxOf(H, idx)
  const visKm = visKmOf(H, idx)

  let score = 0.6 * (100 - mean) + 0.4 * (100 - Math.min(best, 100))
  if (precipMax >= 50) score -= 15
  else if (precipMax >= 25) score -= 6
  if (dewGap !== null && dewGap < 2) score -= 8
  else if (dewGap !== null && dewGap < 4) score -= 4
  if (windMax !== null && windMax > 40) score -= 8
  else if (windMax !== null && windMax > 28) score -= 4
  if (visKm !== null && visKm < 12) score -= 4
  score = Math.max(0, Math.min(100, score))

  return {
    status: 'ok',
    score: Math.round(score),
    cloudMean: Math.round(mean),
    clearHours,
    best3Start: H.time[idx[bestAt]]?.slice(11, 16) ?? null,
    best3Cloud: Math.round(best),
    precipMax,
    dewGap: dewGap === null ? null : Math.round(dewGap * 10) / 10,
    tMin: tempMinOf(H, idx) === null ? null : Math.round(tempMinOf(H, idx) * 10) / 10,
    windMax: windMax === null ? null : Math.round(windMax),
    visKm: visKm === null ? null : Math.round(visKm),
    source: data.__source ?? 'open-meteo',
  }
}

/** 白天窗口评分（日食用）。 */
export function scoreDaytime(data, dateStr, fromHM, toHM) {
  const idx = hoursInWindow(data, dateStr, fromHM, toHM)
  if (idx.length === 0) return null
  const H = data.hourly
  const weighted = cloudSeries(H, idx)
  const mean = weighted.reduce((a, b) => a + b, 0) / weighted.length
  const worst = Math.max(...weighted)
  const clearHours = weighted.filter((c) => c < 25).length
  const bestIdx = weighted.indexOf(Math.min(...weighted))

  const precipMax = Math.max(...precipSeries(H, idx))
  const windMax = windMaxOf(H, idx)
  const visKm = visKmOf(H, idx)

  let score = 0.7 * (100 - mean) + 0.3 * (100 - worst)
  if (precipMax >= 50) score -= 15
  else if (precipMax >= 25) score -= 6
  if (windMax !== null && windMax > 40) score -= 8
  else if (windMax !== null && windMax > 28) score -= 4
  if (visKm !== null && visKm < 12) score -= 4
  score = Math.max(0, Math.min(100, score))

  return {
    status: 'ok',
    score: Math.round(score),
    cloudMean: Math.round(mean),
    clearHours,
    best3Start: H.time[idx[bestIdx]]?.slice(11, 16) ?? null,
    best3Cloud: Math.round(weighted[bestIdx]),
    precipMax,
    dewGap: dewGapOf(H, idx) === null ? null : Math.round(dewGapOf(H, idx) * 10) / 10,
    tMin: tempMinOf(H, idx) === null ? null : Math.round(tempMinOf(H, idx) * 10) / 10,
    windMax: windMax === null ? null : Math.round(windMax),
    visKm: visKm === null ? null : Math.round(visKm),
    source: data.__source ?? 'open-meteo',
    daytime: true,
  }
}

/** 取一个站点指定日期的夜间天气评分（永远 resolve）。 */
export async function nightWeather(site, dateStr, now = new Date()) {
  if (!weatherAvailable(dateStr, now)) {
    return { status: 'out_of_range', score: null, source: chosen?.name ?? null }
  }
  try {
    const data = await fetchSite(site)
    const scored = scoreNight(data, dateStr)
    return scored ?? { status: 'no_data', score: null, source: data.__source }
  } catch (error) {
    return { status: 'unavailable', score: null, source: null, error: String(error?.message ?? error) }
  }
}

/** 取一个站点指定时段（本地时间）的白天天气评分（永远 resolve）。 */
export async function dayWeather(site, dateStr, fromHM, toHM, now = new Date()) {
  if (!weatherAvailable(dateStr, now)) {
    return { status: 'out_of_range', score: null, source: chosen?.name ?? null }
  }
  try {
    const data = await fetchSite(site)
    const scored = scoreDaytime(data, dateStr, fromHM, toHM)
    return scored ?? { status: 'no_data', score: null, source: data.__source }
  } catch (error) {
    return { status: 'unavailable', score: null, source: null, error: String(error?.message ?? error) }
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

/** 可用源列表（调试/文档用）。 */
export function weatherSources() {
  return SOURCES.map((source) => ({ id: source.id, name: source.name, fields: source.fields }))
}

export { SOURCE_BY_ID }
