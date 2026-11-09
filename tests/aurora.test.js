import assert from 'node:assert/strict'
import test from 'node:test'

import * as aurora from '../lib/aurora.js'
import * as catalog from '../lib/catalog.js'
import { search } from '../lib/planner.js'

/** 构造 NOAA 风格的 Kp 序列（3 小时一条，UTC）。 */
function kpRows(kp, startIso, hours = 96) {
  const rows = []
  const t0 = new Date(startIso).getTime()
  for (let h = 0; h < hours; h += 3) {
    const t = new Date(t0 + h * 3600000).toISOString().replace('Z', '').replace('T', ' ')
    rows.push({ time_tag: t, kp, observed: 'predicted' })
  }
  return rows
}

function stubFetch(rows) {
  const real = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => rows })
  aurora.clearAuroraCache()
  return () => { globalThis.fetch = real; aurora.clearAuroraCache() }
}

test('极光几何：地磁纬度与所需 Kp 合理', () => {
  const mohe = catalog.SITES.find((s) => s.name === '漠河')
  const changbai = catalog.SITES.find((s) => s.name === '长白山天池')
  const magMohe = aurora.geomagneticLatitude(mohe.lat, mohe.lon)
  const magChangbai = aurora.geomagneticLatitude(changbai.lat, changbai.lon)
  assert.ok(magMohe > 41 && magMohe < 48, `漠河地磁纬度 ${magMohe}`)
  assert.ok(magChangbai < magMohe, '长白山应比漠河更南')
  const needMohe = aurora.requiredKp(magMohe)
  assert.ok(needMohe > 5 && needMohe < 8, `漠河所需 Kp ${needMohe}`)
  assert.ok(aurora.requiredKp(magChangbai) > needMohe, '越往南需要的 Kp 越高')
  assert.ok(aurora.requiredKp(40) > aurora.requiredKp(50), 'requiredKp 应随纬度升高而降低')
})

test('Kp 按夜聚合：UT 07:00–次日 01:00 归属同一夜', () => {
  const rows = [
    ['2027-03-01T06:00:00Z', 1], // 不属于 03-01 夜
    ['2027-03-01T09:00:00Z', 5],
    ['2027-03-01T21:00:00Z', 7],
    ['2027-03-02T00:00:00Z', 6],
    ['2027-03-02T06:00:00Z', 2], // 不属于 03-01 夜
  ].map(([iso, kp]) => ({ time: new Date(iso), kp }))
  const map = aurora.kpByNight(rows)
  assert.equal(map.get('2027-03-01'), 7)
  assert.equal(map.get('2027-03-02'), undefined)
})

test('极光：Kp 够高才有结果，条数不再固定 3 条', async () => {
  const restore = stubFetch(kpRows(9, '2027-03-01T00:00:00Z'))
  try {
    const r = await search({ eventType: 'aurora', dateStart: '2027-03-01', dateEnd: '2027-03-01', pageSize: 20 })
    assert.ok(r.ok, r.message)
    assert.ok(r.ranked.length > 3, `Kp=9 时应有多个站点，实际 ${r.ranked.length}`)
    assert.ok(r.ranked.every((x) => x.target.type === 'aurora'))
  } finally {
    restore()
  }
})

test('极光：曝光按极光经验值（不用 500 法则）', async () => {
  const restore = stubFetch(kpRows(9, '2027-03-01T00:00:00Z'))
  try {
    const r = await search({ eventType: 'aurora', dateStart: '2027-03-01', dateEnd: '2027-03-01', pageSize: 5 })
    assert.ok(r.ok, r.message)
    const p = r.ranked[0].params
    assert.equal(p.rule, 'aurora')
    assert.equal(p.iso, 1600, '极光用 ISO 1600，不按波特尔加倍')
    assert.equal(p.exposureSec, 4)
    assert.equal(p.exposureText, '2–8 s × 30 张', '极光曝光给 2–8 s 区间')
    assert.match(p.hint, /冻结结构/, '极光曝光应给经验值说明')
  } finally {
    restore()
  }
})

test('极光：Kp 不足时不出结果，并说明原因', async () => {
  const restore = stubFetch(kpRows(2, '2027-03-01T00:00:00Z'))
  try {
    const r = await search({ eventType: 'aurora', dateStart: '2027-03-01', dateEnd: '2027-03-01' })
    assert.equal(r.ok, false)
    assert.equal(r.error, 'no_visible')
    assert.match(r.message, /Kp/)
    assert.match(r.message, /不可见/)
  } finally {
    restore()
  }
})

test('极光：Kp 预报不可用时明确返回 no_kp，而不是给假结果', async () => {
  const real = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('network down') }
  try {
    aurora.clearAuroraCache()
    const r = await search({ eventType: 'aurora', dateStart: '2027-03-01', dateEnd: '2027-03-01' })
    assert.equal(r.ok, false)
    assert.equal(r.error, 'no_kp')
  } finally {
    globalThis.fetch = real
    aurora.clearAuroraCache()
  }
})

test('不限类型不再混入极光目标（避免无 Kp 判据的假结果）', async () => {
  const r = await search({ eventType: 'any', dateStart: '2026-12-20', dateEnd: '2026-12-21', pageSize: 20, siteLimit: 20 })
  assert.ok(r.ok, r.message)
  assert.ok(r.ranked.every((x) => x.target.type !== 'aurora'))
})
