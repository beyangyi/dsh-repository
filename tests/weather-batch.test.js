import test from 'node:test'
import assert from 'node:assert/strict'

import { primeWeather, resetWeatherBreaker, resetWeatherCache, weatherBreakerOpen } from '../lib/weather.js'

/** 让「今天 + N 天」落在 7 天预报窗口内（北京时间口径，与 weatherCoverage 一致）。 */
const beijingDay = (offset = 0) => new Date(Date.now() + 8 * 3600 * 1000 + offset * 86400000).toISOString().slice(0, 10)

const sites = Array.from({ length: 90 }, (_, index) => ({
  id: `batch-test-${index}`,
  lat: 30 + index * 0.1,
  lon: 100 + index * 0.1,
}))

const payloadFor = (count) => Array.from({ length: count }, () => ({ hourly: { time: ['2026-11-14T20:00'] } }))

test('天气批量：90 个站点压成 3 次请求（每批 40），并写进缓存', async () => {
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(url)
    const count = decodeURIComponent(url).match(/latitude=([^&]+)/u)[1].split(',').length
    return { ok: true, json: async () => payloadFor(count) }
  }
  try {
    resetWeatherBreaker()
    const ok = await primeWeather(sites)
    assert.equal(ok, true)
    assert.equal(calls.length, 3, `90 站应分 3 批，实际 ${calls.length}`)
    assert.ok(calls[0].includes('latitude=30,30.1,30.2'), '第一批应带上连续坐标')
    assert.ok(calls[0].includes('timezone=Asia%2FShanghai'))

    // 再跑一次不应产生新请求（全部命中缓存）
    const again = await primeWeather(sites)
    assert.equal(again, true)
    assert.equal(calls.length, 3, '缓存命中后不应再发请求')
  } finally {
    globalThis.fetch = realFetch
    resetWeatherBreaker()
  }
})

test('天气熔断：一次失败后本次查询不再发请求', async () => {
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    throw new Error('network down')
  }
  try {
    resetWeatherBreaker()
    const ok = await primeWeather(sites.map((site) => ({ ...site, id: `breaker-${site.id}` })))
    assert.equal(ok, false)
    assert.equal(weatherBreakerOpen(), true)
    const before = calls
    const second = await primeWeather(sites.map((site) => ({ ...site, id: `breaker2-${site.id}` })))
    assert.equal(second, false)
    assert.equal(calls, before, '熔断后不应再发请求')
  } finally {
    globalThis.fetch = realFetch
    resetWeatherBreaker()
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
    assert.ok(result.ranked.length > 0, '天气取不到时仍应有结果（回归：以前会整天丢光）')
    assert.ok(result.notes.some((note) => note.includes('天气数据暂不可用')), '应有一句说明天气降级')
    for (const item of result.ranked.slice(0, 3)) {
      assert.equal(item.weather.score, null)
      assert.equal(item.weather.status, 'unavailable')
    }
  } finally {
    globalThis.fetch = realFetch
    resetWeatherBreaker()
  }
})
