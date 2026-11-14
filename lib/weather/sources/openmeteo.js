/**
 * Open-Meteo —— 免 key、批量（一次多坐标）、字段最全（含降水概率、能见度、分层云量）。
 * 国内链路不稳，作为第二顺位；批量把 20 站压成 1 次请求。
 */

import { emptySeries } from './common.js'

export const id = 'openmeteo'
export const name = 'Open-Meteo'
export const fields = ['cloud', 'low', 'mid', 'high', 'precipProb', 'temp', 'dew', 'wind', 'vis']

const API = 'https://api.open-meteo.com/v1/forecast'
const HOURLY = [
  'cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high',
  'precipitation_probability', 'relative_humidity_2m', 'dew_point_2m',
  'temperature_2m', 'wind_speed_10m', 'visibility',
].join(',')

const BATCH_SIZE = 40

async function fetchBatch(chunk, days, deadline) {
  const lats = chunk.map((site) => site.lat).join(',')
  const lons = chunk.map((site) => site.lon).join(',')
  const url = `${API}?latitude=${lats}&longitude=${lons}&hourly=${encodeURIComponent(HOURLY)}`
    + `&start_date=${days.from}&end_date=${days.to}&timezone=Asia%2FShanghai`
  const remain = Math.max(1500, Math.min(4000, deadline - Date.now()))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), remain)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    const list = Array.isArray(json) ? json : [json]
    if (list.length !== chunk.length) throw new Error('batch size mismatch')
    return list
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchSites(sites, days) {
  const map = new Map()
  const chunks = []
  for (let i = 0; i < sites.length; i += BATCH_SIZE) chunks.push(sites.slice(i, i + BATCH_SIZE))
  await Promise.all(chunks.map(async (chunk) => {
    try {
      const list = await fetchBatch(chunk, days, days.deadline ?? Date.now() + 4000)
      chunk.forEach((site, index) => {
        const payload = list[index]
        if (!payload?.hourly?.time) return
        map.set(site.id, { ...payload, __source: name })
      })
    } catch {
      /* 这一批失败，其他批继续 */
    }
  }))
  return map
}

export { BATCH_SIZE }
