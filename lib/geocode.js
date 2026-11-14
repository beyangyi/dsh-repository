/**
 * 地点搜索：本地库（173 站点 / 省份 / 城市）+ Open-Meteo Geocoding。
 *
 * 实测：Open-Meteo 地理编码对中文友好（冷湖 921ms、青海湖 265ms），免 key；
 * Nominatim 在这台机器上连不通，不作为候选。
 */

const API = 'https://geocoding-api.open-meteo.com/v1/search'
const CACHE_TTL_MS = 10 * 60 * 1000
const cache = new Map() // query -> { at, results }

export function resetGeocodeCache() {
  cache.clear()
}

/** 本地命中：站名/站点 id、省名、城市名。 */
export function localPlaces(query, { sites = [], provinces = [], cities = {} } = {}) {
  const q = String(query ?? '').trim()
  if (!q) return []
  const out = []
  const weight = (text, q2) => {
    if (!text) return 0
    if (text === q2) return 3
    if (text.startsWith(q2)) return 2
    if (text.includes(q2)) return 1
    return 0
  }
  for (const site of sites) {
    const score = Math.max(weight(site.name, q), weight(site.id, q))
    if (score) out.push({ name: site.name, sub: `${site.province ?? ''} · 站点`, lat: site.lat, lon: site.lon, source: 'site', score, id: site.id })
  }
  // provinces 既可能是数组，也可能是 { 省名: [地区, minLat, maxLat, minLon, maxLon] }
  const provinceEntries = Array.isArray(provinces)
    ? provinces.map((item) => [typeof item === 'string' ? item : item.name, item.center ?? null])
    : Object.entries(provinces ?? {}).map(([name, box]) => [
      name,
      Array.isArray(box) && box.length >= 5 ? [Math.round((box[3] + box[4]) / 2 * 100) / 100, Math.round((box[1] + box[2]) / 2 * 100) / 100] : null,
    ])
  for (const [name, center] of provinceEntries) {
    if (!name) continue
    const score = weight(name, q)
    if (score) out.push({ name, sub: '省级行政区', lat: center?.[1] ?? null, lon: center?.[0] ?? null, source: 'province', score })
  }
  for (const [name, coord] of Object.entries(cities ?? {})) {
    // 城市库用「北京」这种不带后缀的写法，用户常输入「北京市」
    const score = Math.max(weight(name, q), weight(`${name}市`, q))
    if (score && Array.isArray(coord)) out.push({ name, sub: '城市', lat: coord[0], lon: coord[1], source: 'city', score })
  }
  out.sort((a, b) => b.score - a.score || a.name.length - b.name.length)
  return dedupe(out).slice(0, 5)
}

function dedupe(list) {
  const seen = new Set()
  const out = []
  for (const item of list) {
    if (item.lat == null || item.lon == null) { out.push(item); continue }
    const key = `${item.lat.toFixed(2)},${item.lon.toFixed(2)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/** 远端地名搜索（Open-Meteo）。失败返回 []，不抛。 */
export async function remotePlaces(query, { timeoutMs = 4000 } = {}) {
  const q = String(query ?? '').trim()
  if (!q) return []
  const hit = cache.get(q)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.results
  const url = `${API}?name=${encodeURIComponent(q)}&count=6&language=zh&format=json`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'dsh-astro-plan/0.2.0' }, signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    const results = (json?.results ?? [])
      .filter((item) => Number.isFinite(item.latitude) && Number.isFinite(item.longitude))
      .map((item) => ({
        name: item.name,
        sub: [item.admin1, item.country].filter(Boolean).join(' · ') || '地名',
        lat: item.latitude,
        lon: item.longitude,
        source: 'geonames',
        score: 0,
      }))
    cache.set(q, { at: Date.now(), results })
    return results
  } catch {
    cache.set(q, { at: Date.now(), results: [] })
    return []
  } finally {
    clearTimeout(timer)
  }
}

/** 合并结果：本地优先，远端补足，去重，最多 8 条。 */
export async function searchPlaces(query, options = {}) {
  const q = String(query ?? '').trim()
  if (!q) return []
  const local = localPlaces(q, options)
  if (local.length >= 5 || options.localOnly) return dedupe(local).slice(0, 8)
  const remote = await remotePlaces(q, { timeoutMs: options.timeoutMs })
  return dedupe([...local, ...remote]).slice(0, 8)
}
