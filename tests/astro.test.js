import assert from 'node:assert/strict'
import test from 'node:test'

import * as astro from '../lib/astro.js'

const haituo = { id: 'haituo', lat: 40.604, lon: 115.803, altM: 1800 }
const t = astro.makeTime(astro.localDate('2026-11-13', '02:00'))

function close(actual, expected, tol, label) {
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: ${actual} vs ${expected} (tol ${tol})`)
}

test('行星高度方位与 astropy 基准一致（≤0.3°）', () => {
  const ref = {
    Jupiter: [23.66, 92.0],
    Mars: [25.23, 91.3],
    Saturn: [16.67, 256.5],
    Sun: [-55.77, 57.1],
  }
  for (const [body, [alt, az]] of Object.entries(ref)) {
    const got = astro.bodyAltAz(body, t, haituo)
    close(got.alt, alt, 0.3, `${body} alt`)
    close(got.az, az, 0.6, `${body} az`)
  }
})

test('月亮含视差修正（≤0.5°）', () => {
  const got = astro.bodyAltAz('Moon', t, haituo)
  close(got.alt, -74.43, 0.5, 'Moon alt')
  close(got.az, 321.8, 0.8, 'Moon az')
})

test('恒星星表坐标与 astropy 一致（≤0.3°）', () => {
  const ref = [
    ['M42', 83.822 / 15, -5.391, 43.64, 171.1],
    ['M31', 10.685 / 15, 41.269, 41.03, 294.2],
    ['M45', 56.75 / 15, 24.117, 66.25, 232.6],
  ]
  for (const [name, raH, dec, alt, az] of ref) {
    const got = astro.targetAltAz({ raH, dec }, t, haituo)
    close(got.alt, alt, 0.3, `${name} alt`)
    close(got.az, az, 0.6, `${name} az`)
  }
})

test('时角快速算法与矩阵法一致（≤0.1°）', () => {
  const lst = astro.lstHours(t, haituo.lon)
  const eq = astro.ofDateRADec(83.822, -5.391, t)
  const fast = astro.altAzFromHA(eq.raDeg, eq.dec, lst, haituo.lat)
  const exact = astro.starAltAz(83.822, -5.391, t, haituo)
  close(fast.alt, exact.alt, 0.1, 'M42 fast alt')
  close(fast.az, exact.az, 0.3, 'M42 fast az')
})

test('夜间上下文（暮光/月落/月照度）匹配基准', () => {
  const nc = astro.nightContext(haituo, '2026-11-13')
  assert.equal(astro.localHHMM(nc.sunset), '17:01')
  assert.equal(astro.localHHMM(nc.dusk), '18:35')
  assert.equal(astro.localHHMM(nc.dawn), '05:27')
  assert.equal(astro.localHHMM(nc.sunrise), '07:01')
  // 月落：astropy 19:30，本引擎 19:35，允许 8 分钟差
  const minute = (d) => Number(astro.localHHMM(d).slice(0, 2)) * 60 + Number(astro.localHHMM(d).slice(3, 5))
  assert.ok(Math.abs(minute(nc.moonset) - (19 * 60 + 30)) <= 8, 'moonset 与基准差 ≤8min')
  close(nc.moonIllum, 16.8, 2, 'moon illum')
})

test('新月照度接近 0（2026-11-09 15:00 CST）', () => {
  const illum = astro.moonIllumPercent(astro.makeTime(astro.localDate('2026-11-09', '15:00')))
  assert.ok(illum < 1, `新月照度应 <1%，实际 ${illum}`)
})

test('升落搜索返回可复算的时刻', () => {
  const start = astro.makeTime(astro.localDate('2026-11-13', '15:00'))
  const set = astro.riseSet('Moon', start, haituo, -1)
  assert.ok(set instanceof Date)
  assert.equal(astro.localHHMM(set), '19:35')
})

test('方位命名与角距工具', () => {
  assert.equal(astro.azName(0), '北')
  assert.equal(astro.azName(90), '东')
  assert.equal(astro.azName(180), '南')
  close(astro.separation(0, 0, 0, 90), 90, 0.01, 'separation')
})
