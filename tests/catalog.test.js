import assert from 'node:assert/strict'
import test from 'node:test'

import * as catalog from '../lib/catalog.js'
import { EVENTS, PARAMS, TARGETS } from '../lib/catalog.js'

test('站点库规模与覆盖达标', () => {
  const stats = catalog.siteStats()
  assert.ok(stats.total >= 90, `站点 ${stats.total} < 90`)
  assert.ok(stats.provinces >= 30, `省份 ${stats.provinces} < 30`)
  assert.ok(stats.avgBortle < 4.5, '平均 Bortle 应偏暗')
})

test('站点字段合法', () => {
  for (const s of catalog.SITES) {
    assert.ok(s.id && s.name, 'id/name 必填')
    assert.ok(s.lat >= 18 && s.lat <= 54, `${s.id} 纬度越界`)
    assert.ok(s.lon >= 73 && s.lon <= 135, `${s.id} 经度越界`)
    assert.ok(s.bortle >= 1 && s.bortle <= 9, `${s.id} Bortle 越界`)
    assert.ok(s.foregrounds.length > 0, `${s.id} 缺地景`)
    assert.ok(s.tags.length > 0, `${s.id} 缺 tags`)
  }
  const ids = new Set(catalog.SITES.map((s) => s.id))
  assert.equal(ids.size, catalog.SITES.length, 'id 必须唯一')
})

test('按省份/区域/城市/坐标解析地点', () => {
  const byProvince = catalog.resolveLocation('青海')
  assert.ok(byProvince.sites.length >= 3)
  assert.ok(byProvince.sites.every((s) => s.province === '青海'))

  const byRegion = catalog.resolveLocation('', { region: '西南' })
  assert.ok(byRegion.sites.length >= 10)

  const byId = catalog.resolveLocation('lenghu')
  assert.equal(byId.sites.length, 1)
  assert.equal(byId.sites[0].name, '冷湖俄博梁')

  const byCity = catalog.resolveLocation('成都')
  assert.ok(byCity.sites.length === 5)
  assert.ok(byCity.notes[0].includes('最近 5 站'))

  const byCoord = catalog.resolveLocation('30.6, 104.1')
  assert.equal(byCoord.sites.length, 5)
})

test('目标库覆盖所有天象类型', () => {
  const types = new Set(TARGETS.map((t) => t.type))
  for (const need of ['meteor', 'deepsky', 'milkyway', 'planet', 'startrail', 'zodiacal',
    'aurora', 'lunarEclipse', 'solarEclipse']) {
    assert.ok(types.has(need), `缺少类型 ${need}`)
  }
  assert.ok(!types.has('moon'), '月景类型已移除')
  assert.ok(!types.has('gegenschein'), '对日照类型已移除')
  for (const t of TARGETS) {
    assert.ok(Array.isArray(t.focalFF) && t.focalFF.length === 2, `${t.id} 焦段非法`)
    assert.ok(t.minBortle >= 1 && t.minBortle <= 9, `${t.id} minBortle 非法`)
    if (!t.body) assert.ok(Number.isFinite(t.raH) && Number.isFinite(t.dec), `${t.id} 坐标非法`)
  }
})

test('事件表只保留流星雨，日月食与行星事件改为星历现算', () => {
  const tauN = EVENTS.meteors.find((m) => m.id === 'taurusN')
  assert.ok(tauN)
  assert.equal(new Date(tauN.peakUtc).toISOString(), '2026-11-12T18:00:00.000Z')
  assert.equal(EVENTS.eclipses, undefined, '不应再有手抄月食表')
  assert.equal(EVENTS.planets, undefined, '不应再有手抄行星事件表')
  assert.ok(EVENTS.seasons.some((s) => s.id === 'zodiacal-spring'))
  assert.ok(EVENTS.seasons.some((s) => s.id === 'zodiacal-autumn'))
})

test('参数规则完整', () => {
  // 广角 500 法则、长焦 300 法则（保守一档）
  assert.equal(PARAMS.rules.untrackedMaxSeconds.wide, 500)
  assert.equal(PARAMS.rules.untrackedMaxSeconds.tele, 300)
  assert.ok(PARAMS.rules.isoByBortle['1'] < PARAMS.rules.isoByBortle['6'])
  assert.ok(PARAMS.rules.planetLike.exposureSec > 0 && PARAMS.rules.planetLike.frames > 0)
  // 合：月亮半径要计入张角，否则整轮月亮会被切掉
  assert.ok(PARAMS.rules.conjunction.moonRadiusDeg > 0.2 && PARAMS.rules.conjunction.moonRadiusDeg < 0.4)
  assert.equal(PARAMS.rules.conjunction.sensorShortSide, 24)
})

test('季节判断支持跨年', () => {
  const winter = TARGETS.find((t) => t.id === 'm42')
  assert.ok(catalog.inSeason(winter, 12))
  assert.ok(catalog.inSeason(winter, 1))
  assert.ok(!catalog.inSeason(winter, 7))
})

test('省份表与城市表可用', () => {
  assert.equal(Object.keys(catalog.PROVINCES).length, 34)
  assert.ok(catalog.CITIES['北京'])
  assert.equal(catalog.regionOfProvince('青海'), '西北')
})
