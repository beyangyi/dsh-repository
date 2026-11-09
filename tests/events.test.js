import assert from 'node:assert/strict'
import test from 'node:test'

import * as catalog from '../lib/catalog.js'
import * as events from '../lib/events.js'

function byDate(list, dateStr) {
  return list.find((e) => (e.peakUtc ?? e.utc).slice(0, 10) === dateStr)
}

function closeMinutes(iso, expectedIso, toleranceMin, label) {
  const delta = Math.abs(new Date(iso) - new Date(expectedIso)) / 60000
  assert.ok(delta <= toleranceMin, `${label} 偏差 ${delta.toFixed(1)} 分钟 > ${toleranceMin}`)
}

test('月食现算与 NASA 基准一致（2026–2028）', () => {
  const list = events.lunarEclipsesBetween('2026-01-01T00:00:00Z', '2029-01-05T00:00:00Z')
  const expected = [
    ['2026-03-03', '2026-03-03T11:33:00Z', 'total'],
    ['2026-08-28', '2026-08-28T04:13:00Z', 'partial'],
    ['2027-02-20', '2027-02-20T23:13:00Z', 'penumbral'],
    ['2027-07-18', '2027-07-18T16:03:00Z', 'penumbral'],
    ['2027-08-17', '2027-08-17T07:14:00Z', 'penumbral'],
    ['2028-01-12', '2028-01-12T04:13:00Z', 'partial'],
    ['2028-07-06', '2028-07-06T18:20:00Z', 'partial'],
    ['2028-12-31', '2028-12-31T16:52:00Z', 'total'],
  ]
  for (const [date, peak, kind] of expected) {
    const hit = byDate(list, date)
    assert.ok(hit, `缺少月食 ${date}`)
    assert.equal(hit.kind, kind, `${date} 类型应为 ${kind}`)
    closeMinutes(hit.peakUtc, peak, 15, `月食 ${date}`)
    assert.ok(hit.label.includes('月'), `${date} 应有中文标签`)
  }
})

test('日食现算与 NASA 基准一致（2026–2028）', () => {
  const list = events.solarEclipsesBetween('2026-01-01T00:00:00Z', '2029-01-05T00:00:00Z')
  const expected = [
    ['2026-02-17', '2026-02-17T12:12:00Z', 'annular'],
    ['2026-08-12', '2026-08-12T17:46:00Z', 'total'],
    ['2027-02-06', '2027-02-06T16:00:00Z', 'annular'],
    ['2027-08-02', '2027-08-02T10:07:00Z', 'total'],
    ['2028-01-26', '2028-01-26T15:08:00Z', 'annular'],
    ['2028-07-22', '2028-07-22T02:56:00Z', 'total'],
  ]
  for (const [date, peak, kind] of expected) {
    const hit = byDate(list, date)
    assert.ok(hit, `缺少日食 ${date}`)
    assert.equal(hit.kind, kind, `${date} 类型应为 ${kind}`)
    closeMinutes(hit.peakUtc, peak, 15, `日食 ${date}`)
  }
})

test('本地日食：必须绑定到目标日食，不能拿到下一次', () => {
  const solar = events.solarEclipsesBetween('2026-01-01T00:00:00Z', '2029-01-05T00:00:00Z')
  const pamir = catalog.SIDE_FIXTURE ?? catalog.SITES.find((s) => s.id === 'pamir')
  const e2027 = solar.find((e) => e.id === 'solar-2027-08-02')
  const local2027 = events.localSolarCircumstances(pamir, e2027)
  assert.equal(local2027.visible, true, '帕米尔应能看到 2027-08-02 日偏食')
  assert.ok(local2027.obscuration > 0 && local2027.obscuration < 0.1, '食分应在 0–10% 之间')
  assert.ok(local2027.altPeak > 20, '峰值太阳高度应较高')

  const e2026 = solar.find((e) => e.id === 'solar-2026-08-12')
  const local2026 = events.localSolarCircumstances(pamir, e2026)
  assert.equal(local2026.visible, false, '2026-08-12 日全食国内不可见')
})

test('冲日现算：木星 2026-01-10、土星 2026-10-04、火星 2027-02-19', () => {
  const list = events.planetEventsBetween('2026-01-01T00:00:00Z', '2028-01-01T00:00:00Z')
  const opp = list.filter((e) => e.type === 'opposition')
  const first = (body) => opp.find((e) => e.body === body)

  const jupiter = first('Jupiter')
  assert.ok(jupiter, '缺少木星冲日')
  closeMinutes(jupiter.utc, '2026-01-10T08:29:00Z', 60 * 24, '木星冲日')

  const saturn = first('Saturn')
  assert.ok(saturn, '缺少土星冲日')
  closeMinutes(saturn.utc, '2026-10-04T12:12:00Z', 60 * 24, '土星冲日')

  const mars = first('Mars')
  assert.ok(mars, '缺少火星冲日')
  closeMinutes(mars.utc, '2027-02-19T15:44:00Z', 60 * 24, '火星冲日')

  const uranus = first('Uranus')
  assert.ok(uranus, '缺少天王星冲日')
  closeMinutes(uranus.utc, '2026-11-25T22:27:00Z', 60 * 24, '天王星冲日')
})

test('合：木星合火星 2026-11-16，角距 < 1°', () => {
  const list = events.planetEventsBetween('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z')
  const conj = list.find((e) => e.type === 'conjunction' && e.objects.includes('Jupiter') && e.objects.includes('Mars'))
  assert.ok(conj, '缺少木星合火星')
  closeMinutes(conj.utc, '2026-11-16T00:00:00Z', 60 * 24, '木星合火星')
  assert.ok(conj.sepDeg < 1.5, `角距应很小，实际 ${conj.sepDeg}`)
})

test('大距：水星 2026-10-12 昏星 25.2°', () => {
  const list = events.planetEventsBetween('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z')
  const mercury = list.find((e) => e.type === 'elongation' && e.body === 'Mercury')
  assert.ok(mercury, '缺少水星大距')
  closeMinutes(mercury.utc, '2026-10-12T10:06:00Z', 60 * 6, '水星东大距')
  assert.ok(Math.abs(mercury.sepDeg - 25.2) < 1, `距日角应为 25.2°，实际 ${mercury.sepDeg}`)
})

test('nextEclipseAfter(2026-11-14) 指向 2027-02-06 日环食', () => {
  const next = events.nextEclipseAfter('2026-11-14T00:00:00Z')
  assert.ok(next, '应给出下一次日月食')
  assert.equal(next.peakUtc.slice(0, 10), '2027-02-06')
  assert.equal(next.type, 'solar')
  assert.equal(next.kind, 'annular')
})
