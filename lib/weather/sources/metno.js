/**
 * MET Norway（api.met.no）——免 key、全球、逐时（前 ~48h 逐时，之后 6h）。
 * 字段：云量、温度、湿度、降水（mm）、风；露点由 Magnus 公式推算；无能见度。
 */

import { dewFrom, emptySeries, hourlyAxis, interpolate, mapLimit } from './common.js'

export const id = 'metno'
export const name = 'MET Norway'
export const fields = ['cloud', 'temp', 'humidity', 'dew', 'precipMm', 'wind']

const ENDPOINT = 'https://api.met.no/weatherapi/locationforecast/2.0/compact'
const USER_AGENT = 'dsh-astro-plan/0.1.3 (+https://github.com/SiriusYANG91/dsh-astro-plan)'

function precipOf(point) {
  const one = point.data.next_1_hours?.details?.precipitation_amount
  if (Number.isFinite(one)) return one
  const six = point.data.next_6_hours?.details?.precipitation_amount
  if (Number.isFinite(six)) return six / 6
  return 0
}

async function fetchOne(site, days, deadline) {
  const url = `${ENDPOINT}?lat=${site.lat.toFixed(3)}&lon=${site.lon.toFixed(3)}`
  const remain = Math.max(1200, Math.min(4000, deadline - Date.now()))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), remain)
  try {
    const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    const series = json?.properties?.timeseries
    if (!Array.isArray(series) || series.length < 2) throw new Error('malformed met.no payload')

    const points = series.map((point) => {
      const details = point.data.instant.details
      return {
        t: new Date(point.time).getTime(),
        cloud: Number.isFinite(details.cloud_area_fraction) ? details.cloud_area_fraction : null,
        temp: Number.isFinite(details.air_temperature) ? details.air_temperature : null,
        humidity: Number.isFinite(details.relative_humidity) ? details.relative_humidity : null,
        wind: Number.isFinite(details.wind_speed) ? details.wind_speed * 3.6 : null,
        precip: precipOf(point),
      }
    })

    const out = emptySeries({ from: days.from, to: days.to }, name)
    const axis = hourlyAxis(days.from, days.to)
    const col = out.hourly
    const cloudPts = points.filter((p) => p.cloud !== null).map((p) => [p.t, p.cloud])
    const tempPts = points.filter((p) => p.temp !== null).map((p) => [p.t, p.temp])
    const humPts = points.filter((p) => p.humidity !== null).map((p) => [p.t, p.humidity])
    const windPts = points.filter((p) => p.wind !== null).map((p) => [p.t, p.wind])

    axis.forEach((epoch, index) => {
      const cloud = interpolate(cloudPts, epoch)
      const temp = interpolate(tempPts, epoch)
      const humidity = interpolate(humPts, epoch)
      const wind = interpolate(windPts, epoch)
      const near = points.filter((p) => p.t <= epoch).pop() ?? points[0]
      col.cloud_cover[index] = cloud
      col.cloud_cover_low[index] = cloud
      col.cloud_cover_mid[index] = cloud
      col.cloud_cover_high[index] = cloud
      col.temperature_2m[index] = temp
      col.relative_humidity_2m[index] = humidity
      col.dew_point_2m[index] = dewFrom(temp, humidity)
      col.wind_speed_10m[index] = wind
      col.precipitation_probability[index] = near.precip > 0.1 ? 30 : 0
    })
    return out
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchSites(sites, days) {
  const map = new Map()
  await mapLimit(sites, 6, async (site) => {
    try {
      map.set(site.id, await fetchOne(site, days, days.deadline ?? Date.now() + 4000))
    } catch {
      /* 单站失败不影响其他站点 */
    }
  })
  return map
}
