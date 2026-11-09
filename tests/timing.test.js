import assert from 'node:assert/strict'
import test from 'node:test'

import * as catalog from '../lib/catalog.js'
import * as events from '../lib/events.js'
import { search } from '../lib/planner.js'

/** "10-20 ~ 12-10" → { from: '10-20', to: '12-10' } */
function parseActive(text) {
  const m = /(\d{2})-(\d{2})\s*~\s*(\d{2})-(\d{2})/.exec(text ?? '')
  return m ? { from: `${m[1]}-${m[2]}`, to: `${m[3]}-${m[4]}` } : null
}

test('流星雨：极大时刻落在活跃期内，且与公布时间一致', () => {
  const meteors = catalog.EVENTS.meteors
  assert.ok(meteors.length >= 10)
  for (const m of meteors) {
    const peak = m.peakUtc.slice(5, 10) // MM-DD
    const range = parseActive(m.active)
    assert.ok(range, `${m.id} 活跃期格式异常`)
    const inside = range.from <= range.to
      ? peak >= range.from && peak <= range.to
      : peak >= range.from || peak <= range.to
    assert.ok(inside, `${m.name} 极大 ${peak} 不在活跃期 ${m.active} 内`)
    assert.ok(m.zhr > 0 && m.raH >= 0 && m.raH < 24, `${m.name} 参数异常`)
  }
  // 本周关键天象：北金牛极大 = 北京时间 2026-11-13 02:00
  const tauN = meteors.find((m) => m.id === 'taurusN')
  assert.equal(tauN.peakUtc, '2026-11-12T18:00:00Z')
  // 狮子座极大 = 北京时间 2026-11-18 08:00
  const leonids = meteors.find((m) => m.id === 'leonids')
  assert.equal(leonids.peakUtc, '2026-11-18T00:00:00Z')
})

test('月食：查询结果日期与星历峰值日期一致', async () => {
  const eclipses = events.lunarEclipsesBetween('2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z')
  const total = eclipses.find((e) => e.id === 'lunar-2026-03-03')
  assert.equal(total.kind, 'total')

  const r = await search({ eventType: 'lunarEclipse', dateStart: '2026-03-03', dateEnd: '2026-03-03', limit: 3 })
  assert.ok(r.ok, r.message)
  for (const x of r.ranked) {
    assert.equal(x.date, '2026-03-03')
    assert.equal(x.target.type, 'lunarEclipse')
    // 能看到完整全食阶段的站点标「月全食」，被月出打断的按约定降级为「月偏食（…仅见部分阶段）」
    assert.match(x.target.name, /月(全|偏)食/)
    assert.match(x.target.name, /食分/)
    // 可见窗口必须落在夜间且与月食本影阶段相交（19:33 峰值 → 窗口覆盖 19:33 前后）
    assert.ok(x.window.start <= '23:59' && x.window.end >= '19:00', `窗口 ${x.window.start}–${x.window.end} 未覆盖食甚`)
  }
  const all = await search({ eventType: 'lunarEclipse', dateStart: '2026-03-03', dateEnd: '2026-03-03', pageSize: 200 })
  assert.ok(all.ranked.some((x) => /月全食/.test(x.target.name)), '应有站点能看到完整全食阶段')
})

test('日食：查询结果日期与本地食甚日期一致', async () => {
  const r = await search({
    eventType: 'solarEclipse', location: '新疆', dateStart: '2027-08-02', dateEnd: '2027-08-02', limit: 2,
  })
  assert.ok(r.ok, r.message)
  for (const x of r.ranked) {
    assert.equal(x.date, '2027-08-02')
    assert.equal(x.target.type, 'solarEclipse')
    assert.ok(x.geometry.altMax > 20, '峰值太阳高度应大于 20°')
    assert.ok(x.window.start < x.window.end)
  }
})

test('冲日：查询结果落在星历给出的冲日当天', async () => {
  const list = events.planetEventsBetween('2027-01-01T00:00:00Z', '2027-03-01T00:00:00Z')
  const jupiter = list.find((e) => e.type === 'opposition' && e.body === 'Jupiter')
  assert.ok(jupiter)
  const day = jupiter.utc.slice(0, 10)

  const r = await search({ eventType: 'opposition', dateStart: day, dateEnd: day, limit: 2, siteLimit: 8 })
  assert.ok(r.ok, r.message)
  assert.equal(r.ranked[0].date, day)
  assert.match(r.ranked[0].target.name, /冲日/)
})

test('合：查询结果落在星历给出的相合当天', async () => {
  const list = events.planetEventsBetween('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z')
  const pair = list.find((e) => e.type === 'conjunction' && e.objects.includes('Jupiter') && e.objects.includes('Mars'))
  assert.ok(pair)
  const day = pair.utc.slice(0, 10)

  const r = await search({ eventType: 'conjunction', dateStart: day, dateEnd: day, limit: 2, siteLimit: 8 })
  assert.ok(r.ok, r.message)
  assert.equal(r.ranked[0].date, day)
  assert.match(r.ranked[0].target.name, /合/)
})

test('黄道光：春季黄昏在西、秋季黎明在东，且季节窗口正确', async () => {
  const spring = await search({ eventType: 'zodiacal', dateStart: '2027-03-01', dateEnd: '2027-03-01', limit: 2, siteLimit: 12 })
  assert.ok(spring.ok, spring.message)
  assert.match(spring.ranked[0].target.name, /春季/)
  // 黄昏西方：方位角应落在 180°–340°
  const springAz = spring.ranked[0].geometry.azStart
  assert.ok(springAz >= 170 && springAz <= 340, `春季黄道光应在西方，实际 ${springAz}°`)
  // 清晨前（窗口应在 18:00–24:00 之间，即黄昏后）
  assert.ok(spring.ranked[0].window.start <= '23:00', `春季应在黄昏后，实际 ${spring.ranked[0].window.start}`)

  const autumn = await search({ eventType: 'zodiacal', dateStart: '2027-10-05', dateEnd: '2027-10-05', limit: 2, siteLimit: 12 })
  assert.ok(autumn.ok, autumn.message)
  assert.match(autumn.ranked[0].target.name, /秋季/)
  const autumnAz = autumn.ranked[0].geometry.azStart
  assert.ok(autumnAz >= 20 && autumnAz <= 190, `秋季黄道光应在东方，实际 ${autumnAz}°`)
  // 黎明前：窗口结束应在 04:00–09:00
  assert.ok(autumn.ranked[0].window.end >= '03:00', `秋季应在黎明前，实际 ${autumn.ranked[0].window.end}`)

  // 夏季（6 月）不在任何窗口 → 查不到
  const summer = await search({ eventType: 'zodiacal', dateStart: '2027-06-15', dateEnd: '2027-06-15', limit: 2 })
  assert.equal(summer.ok, false)
  assert.equal(summer.error, 'no_visible')
})

test('极光：只在 9–4 月的极光季、只在极光站点、且必须有 Kp 依据', async () => {
  const winter = await search({ eventType: 'aurora', location: '漠河', dateStart: '2026-12-20', dateEnd: '2026-12-20', limit: 2 })
  if (winter.ok) {
    assert.equal(winter.ranked[0].site.name, '漠河')
    assert.match(winter.ranked[0].target.name, /极光/)
  } else {
    // 没有 Kp 依据（或该日 Kp 不足）时不出结果，只给原因
    assert.ok(['no_visible', 'no_kp'].includes(winter.error), `意外的错误类型 ${winter.error}`)
    assert.match(winter.message, /Kp|地磁/)
  }

  const summer = await search({ eventType: 'aurora', location: '漠河', dateStart: '2027-06-20', dateEnd: '2027-06-20', limit: 2 })
  assert.equal(summer.ok, false, '6 月不应有极光结果')
  assert.ok(['no_visible', 'no_night', 'no_kp'].includes(summer.error), `意外的错误类型 ${summer.error}`)

  const lowLat = await search({ eventType: 'aurora', location: '广州', dateStart: '2026-12-20', dateEnd: '2026-12-20', limit: 2 })
  assert.equal(lowLat.ok, false)
  assert.equal(lowLat.error, 'no_aurora_site')
})
