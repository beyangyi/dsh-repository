import test from 'node:test'
import assert from 'node:assert/strict'

import * as openmeteo from '../lib/weather/sources/openmeteo.js'
import * as metno from '../lib/weather/sources/metno.js'
import * as timer7 from '../lib/weather/sources/timer7.js'
import {
  primeWeather, resetWeatherBreaker, resetWeatherCache, scoreNight, weatherBreakerOpen, weatherSourceName,
} from '../lib/weather.js'

const DAY = '2026-11-15'
const beijingDay = (offset = 0) => new Date(Date.now() + 8 * 3600 * 1000 + offset * 86400000).toISOString().slice(0, 10)

/** Open-Meteo 批量形状的假响应。 */
const openMeteoPayload = (count) => Array.from({ length: count }, () => ({
  hourly: {
    time: [`${DAY}T20:00`, `${DAY}T21:00`, `${DAY}T22:00`],
    cloud_cover: [10, 20, 30],
    cloud_cover_low: [5, 10, 15],
    cloud_cover_mid: [10, 20, 30],
    cloud_cover_high: [20, 30, 40],
    precipitation_probability: [0, 0, 5],
    temperature_2m: [2, 1, 0],
    dew_point_2m: [-6, -7, -8],
    wind_speed_10m: [5, 6, 7],
    visibility: [24000, 24000, 24000],
  },
}))

test('Open-Meteo 批量：90 站压成 3 次请求，且能归一化出数据', async () => {
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    const count = decodeURIComponent(String(url)).match(/latitude=([^&]+)/u)[1].split(',').length
    return { ok: true, json: async () => openMeteoPayload(count) }
  }
  try {
    const sites = Array.from({ length: 90 }, (_, index) => ({ id: `om-${index}`, lat: 30 + index * 0.1, lon: 100 + index * 0.1 }))
    const map = await openmeteo.fetchSites(sites, { from: beijingDay(1), to: beijingDay(7), deadline: Date.now() + 4000 })
    assert.equal(map.size, 90)
    assert.equal(calls.length, 3, `90 站应分 3 批，实际 ${calls.length}`)
    assert.equal(map.get('om-0').__source, 'Open-Meteo')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('MET Norway：云量/温度/湿度归一化，露点由 Magnus 推算', async () => {
  const realFetch = globalThis.fetch
  const base = Date.parse(`${beijingDay(1)}T00:00:00+08:00`)
  const series = Array.from({ length: 24 }, (_, hour) => ({
    time: new Date(base + hour * 3600 * 1000).toISOString().replace('.000', ''),
    data: {
      instant: { details: { cloud_area_fraction: 12, air_temperature: 3, relative_humidity: 60, wind_speed: 2 } },
      next_1_hours: { details: { precipitation_amount: 0 } },
    },
  }))
  globalThis.fetch = async (url) => {
    assert.match(String(url), /api\.met\.no/u)
    return { ok: true, json: async () => ({ properties: { timeseries: series } }) }
  }
  try {
    const map = await metno.fetchSites([{ id: 'met-1', lat: 40.6, lon: 115.8 }], { from: beijingDay(1), to: beijingDay(7), deadline: Date.now() + 4000 })
    const data = map.get('met-1')
    assert.ok(data, '应拿到 met.no 数据')
    assert.equal(data.__source, 'MET Norway')
    const hourIndex = data.hourly.time.indexOf(`${beijingDay(1)}T20`)
    assert.ok(hourIndex >= 0, '应包含北京时间的 20 点')
    assert.equal(data.hourly.cloud_cover[hourIndex], 12)
    assert.equal(data.hourly.temperature_2m[hourIndex], 3)
    assert.ok(data.hourly.dew_point_2m[hourIndex] < 3, '露点应低于温度')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('7Timer：云量档位映射为百分比', async () => {
  const realFetch = globalThis.fetch
  const init = `${beijingDay(1).replaceAll('-', '')}00`
  const series = Array.from({ length: 24 }, (_, index) => ({
    timepoint: index * 3,
    cloudcover: index === 0 ? 1 : 9,
    temp2m: 5,
    rh2m: 5,
    prec_type: 'none',
    seeing: 3,
    transparency: 3,
  }))
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ product: 'astro', init, dataseries: series }) })
  try {
    const map = await timer7.fetchSites([{ id: 't7-1', lat: 40.6, lon: 115.8 }], { from: beijingDay(1), to: beijingDay(3), deadline: Date.now() + 4000 })
    const data = map.get('t7-1')
    assert.ok(data)
    assert.equal(data.__source, '7Timer')
    const first = data.hourly.cloud_cover[0]
    const later = data.hourly.cloud_cover[Math.min(20, data.hourly.cloud_cover.length - 1)]
    assert.ok(first <= 5, `第 0 小时云量应很低，实际 ${first}`)
    assert.ok(later >= 90, `后续小时云量应很高，实际 ${later}`)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('多源择优：首选源失败自动切到下一个可用源', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.met.no')) throw new Error('met.no down')
    const count = decodeURIComponent(String(url)).match(/latitude=([^&]+)/u)?.[1]?.split(',').length ?? 1
    return { ok: true, json: async () => openMeteoPayload(count) }
  }
  try {
    resetWeatherBreaker()
    resetWeatherCache()
    const sites = [{ id: 'pick-1', lat: 40.6, lon: 115.8 }]
    const ok = await primeWeather(sites)
    assert.equal(ok, true, '首选失败后应由次选源补上')
    assert.equal(weatherSourceName(), 'Open-Meteo')
  } finally {
    globalThis.fetch = realFetch
    resetWeatherBreaker()
    resetWeatherCache()
  }
})

test('全部源失败：熔断且不再发请求，评分返回 unavailable', async () => {
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    throw new Error('network down')
  }
  try {
    resetWeatherBreaker()
    resetWeatherCache()
    const sites = [{ id: 'fail-1', lat: 40.6, lon: 115.8 }]
    const ok = await primeWeather(sites)
    assert.equal(ok, false)
    assert.equal(weatherBreakerOpen(), true)
    const before = calls
    const again = await primeWeather([{ id: 'fail-2', lat: 39, lon: 116 }])
    assert.equal(again, false)
    assert.equal(calls, before, '熔断后不应再发请求')
  } finally {
    globalThis.fetch = realFetch
    resetWeatherBreaker()
    resetWeatherCache()
  }
})

test('天气不可用不影响检索：结果照出，只降级成纯天文排序', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = () => Promise.reject(new Error('network down'))
  try {
    resetWeatherBreaker()
    resetWeatherCache()
    const { search } = await import('../lib/planner.js')
    const result = await search({ eventType: 'any', dateStart: beijingDay(1), dateEnd: beijingDay(3), pageSize: 5 })
    assert.equal(result.ok, true)
    assert.ok(result.ranked.length > 0, '天气取不到时仍应有结果')
    assert.ok(result.notes.some((note) => note.includes('天气数据暂不可用')), '应有一句说明天气降级')
    assert.equal(result.ranked[0].weather.score, null)
  } finally {
    globalThis.fetch = realFetch
    resetWeatherBreaker()
    resetWeatherCache()
  }
})

test('评分兼容缺字段：只有云量时仍能算分，且不误扣能见度/结露', () => {
  const data = {
    __source: '7Timer',
    hourly: {
      time: [`${DAY}T20`, `${DAY}T21`, `${DAY}T22`],
      cloud_cover: [0, 0, 0],
      cloud_cover_low: [null, null, null],
      cloud_cover_mid: [null, null, null],
      cloud_cover_high: [null, null, null],
      precipitation_probability: [null, null, null],
      temperature_2m: [null, null, null],
      dew_point_2m: [null, null, null],
      wind_speed_10m: [null, null, null],
      visibility: [null, null, null],
    },
  }
  const scored = scoreNight(data, DAY)
  assert.ok(scored)
  assert.equal(scored.source, '7Timer')
  assert.equal(scored.score, 100, '全晴且无其他扣分项应满分')
  assert.equal(scored.visKm, null)
  assert.equal(scored.dewGap, null)
})
