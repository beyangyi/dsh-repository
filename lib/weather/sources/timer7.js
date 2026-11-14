/**
 * 7Timer! astro —— 免 key 的天文专用预报：云量 1–9 档、透明度、seeing，3 小时一档、72 小时。
 * 只作保底源：只有云量与温度、湿度档位、降水类型，没有能见度与降水概率。
 */

import { emptySeries, hourlyAxis, interpolate, mapLimit } from './common.js'

export const id = 'timer7'
export const name = '7Timer'
export const fields = ['cloud', 'temp', 'humidity', 'precipProb']

const ENDPOINT = 'https://www.7timer.info/bin/astro.php'
const USER_AGENT = 'dsh-astro-plan/0.1.3 (+https://github.com/SiriusYANG91/dsh-astro-plan)'

/** 云量 1–9 档 → 百分比中值。 */
const CLOUD_PCT = { 1: 3, 2: 12, 3: 25, 4: 37, 5: 50, 6: 62, 7: 75, 8: 87, 9: 97 }
/** 相对湿度 1–9 档 → 百分比中值。 */
const RH_PCT = { 1: 15, 2: 25, 3: 35, 4: 45, 5: 55, 6: 65, 7: 75, 8: 85, 9: 95 }

async function fetchOne(site, days, deadline) {
  const url = `${ENDPOINT}?lon=${site.lon.toFixed(3)}&lat=${site.lat.toFixed(3)}&ac=0&unit=metric&output=json&tzshift=0`
  const remain = Math.max(1200, Math.min(4000, deadline - Date.now()))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), remain)
  try {
    const res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    const list = json?.dataseries
    if (!Array.isArray(list) || list.length < 2) throw new Error('malformed 7timer payload')

    const initMs = Date.parse(`${json.init.slice(0, 4)}-${json.init.slice(4, 6)}-${json.init.slice(6, 8)}T${json.init.slice(8, 10)}:00:00Z`)
    const points = list.map((entry) => ({
      t: initMs + entry.timepoint * 3600 * 1000,
      cloud: CLOUD_PCT[entry.cloudcover] ?? 50,
      temp: Number.isFinite(entry.temp2m) ? entry.temp2m : null,
      humidity: RH_PCT[entry.rh2m] ?? null,
      precip: entry.prec_type && entry.prec_type !== 'none' ? 60 : 0,
    }))

    const out = emptySeries({ from: days.from, to: days.to }, name)
    const axis = hourlyAxis(days.from, days.to)
    const col = out.hourly
    const cloudPts = points.map((p) => [p.t, p.cloud])
    const tempPts = points.filter((p) => p.temp !== null).map((p) => [p.t, p.temp])
    const rhPts = points.filter((p) => p.humidity !== null).map((p) => [p.t, p.humidity])

    axis.forEach((epoch, index) => {
      const cloud = interpolate(cloudPts, epoch)
      const temp = interpolate(tempPts, epoch)
      const humidity = interpolate(rhPts, epoch)
      const near = points.filter((p) => p.t <= epoch).pop() ?? points[0]
      col.cloud_cover[index] = cloud
      col.cloud_cover_low[index] = cloud
      col.cloud_cover_mid[index] = cloud
      col.cloud_cover_high[index] = cloud
      col.temperature_2m[index] = temp
      col.relative_humidity_2m[index] = humidity
      col.precipitation_probability[index] = near.precip
    })
    return out
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchSites(sites, days) {
  const map = new Map()
  await mapLimit(sites, 5, async (site) => {
    try {
      map.set(site.id, await fetchOne(site, days, days.deadline ?? Date.now() + 4000))
    } catch {
      /* 单站失败忽略 */
    }
  })
  return map
}
