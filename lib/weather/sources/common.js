/**
 * 天气源公共工具：并发限制、时间轴、露点换算。
 */

export const DEW_MISSING = null

/** 简单并发池：不限顺序，全部跑完才 resolve。 */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await fn(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** 北京时间（UTC+8）的 ISO 小时字符串，与 Open-Meteo 的 hourly.time 同构。 */
export function isoHour(epochMs) {
  return new Date(epochMs + 8 * 3600 * 1000).toISOString().slice(0, 13).replace('T', 'T')
}

/** 生成 [from 00:00, to 23:00] 的逐小时时间轴（北京时间）。 */
export function hourlyAxis(fromDay, toDay) {
  const start = new Date(`${fromDay}T00:00:00+08:00`).getTime()
  const end = new Date(`${toDay}T23:00:00+08:00`).getTime()
  const out = []
  for (let t = start; t <= end; t += 3600 * 1000) out.push(t)
  return out
}

/** Magnus 公式：由温度(℃)与相对湿度(%) 估露点。 */
export function dewFrom(temp, humidity) {
  if (!Number.isFinite(temp) || !Number.isFinite(humidity) || humidity <= 0) return null
  const a = 17.62
  const b = 243.12
  const rh = Math.min(100, Math.max(1, humidity))
  const gamma = Math.log(rh / 100) + (a * temp) / (b + temp)
  return (b * gamma) / (a - gamma)
}

/** 线性插值：给定 (x, y) 点列，在 x 处取值；超出范围取端点。 */
export function interpolate(points, x) {
  if (!points.length) return null
  if (x <= points[0][0]) return points[0][1]
  if (x >= points[points.length - 1][0]) return points[points.length - 1][1]
  for (let i = 1; i < points.length; i += 1) {
    if (x <= points[i][0]) {
      const [x0, y0] = points[i - 1]
      const [x1, y1] = points[i]
      if (x1 === x0) return y1
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)
    }
  }
  return points[points.length - 1][1]
}

/** 统一的「Open-Meteo 形状」空壳，源只填自己有的列。 */
export function emptySeries(days, source) {
  const time = hourlyAxis(days.from, days.to)
  const fill = (value) => new Array(time.length).fill(value)
  return {
    __source: source,
    hourly: {
      time: time.map((t) => new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 13)),
      cloud_cover: fill(null),
      cloud_cover_low: fill(null),
      cloud_cover_mid: fill(null),
      cloud_cover_high: fill(null),
      precipitation_probability: fill(null),
      temperature_2m: fill(null),
      dew_point_2m: fill(null),
      relative_humidity_2m: fill(null),
      wind_speed_10m: fill(null),
      visibility: fill(null),
    },
  }
}
