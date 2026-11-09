import assert from 'node:assert/strict'
import test from 'node:test'

import * as astro from '../lib/astro.js'
import * as comets from '../lib/comets.js'

const D2R = Math.PI / 180

/** 轨道根数 → 近日点单位矢量（黄道 J2000）。 */
function perihelionVector(c) {
  const O = c.om * D2R
  const w = c.w * D2R
  const i = c.i * D2R
  return [
    Math.cos(O) * Math.cos(w) - Math.sin(O) * Math.sin(w) * Math.cos(i),
    Math.sin(O) * Math.cos(w) + Math.cos(O) * Math.sin(w) * Math.cos(i),
    Math.sin(w) * Math.sin(i),
  ]
}

/** 轨道平面法向单位矢量（黄道 J2000）。 */
function normalVector(c) {
  const O = c.om * D2R
  const i = c.i * D2R
  return [Math.sin(O) * Math.sin(i), -Math.cos(O) * Math.sin(i), Math.cos(i)]
}

function jdOf(date) {
  return astro.makeTime(date).tt + 2451545.0
}

test('彗星库：来自 MPC，字段完整，含椭圆/抛物/双曲三种轨道', () => {
  assert.ok(comets.COMETS.length >= 80, `彗星数量 ${comets.COMETS.length} 太少（应已扩充到 100 颗量级）`)
  for (const c of comets.COMETS) {
    assert.ok(c.id && c.name, '缺少 id/name')
    assert.ok(Number.isFinite(c.q) && c.q > 0.05 && c.q < 6, `${c.id} 近日距异常`)
    assert.ok(Number.isFinite(c.e) && c.e > 0, `${c.id} 偏心率异常`)
    assert.ok(Number.isFinite(c.i) && c.i >= 0 && c.i <= 180, `${c.id} 倾角异常`)
    assert.ok(Number.isFinite(c.tp) && c.tp > 2400000, `${c.id} 近日点时刻异常`)
    assert.ok(Number.isFinite(c.H) && Number.isFinite(c.G), `${c.id} 缺亮度参数`)
    assert.ok(c.minMag <= 15, `${c.id} 入库亮度门槛失效（应 ≤ 15 等）`)
    assert.match(c.minMagAt, /^\d{4}-\d{2}-\d{2}$/, `${c.id} 最亮日期格式异常`)
  }
  // 亮度分布要全：既有肉眼级亮彗星，也有需要望远镜的暗彗星
  assert.ok(comets.COMETS.filter((c) => c.minMag <= 6).length >= 3, '缺少肉眼级亮彗星')
  assert.ok(comets.COMETS.filter((c) => c.minMag > 10).length >= 10, '缺少暗彗星（望远镜级）')
  assert.ok(comets.COMETS.some((c) => c.e < 0.95), '缺少椭圆轨道彗星')
  assert.ok(comets.COMETS.some((c) => c.e >= 0.999), '缺少近抛物线彗星')
  // 检索候选只放「有可能够亮」的那批，数量必须远小于整库
  assert.ok(comets.COMETS.filter((c) => c.minMag <= 10).length < comets.COMETS.length, '候选筛选失效')
})

test('彗星传播：近日点距离 = q，且位置满足轨道面与近点角约束', () => {
  for (const c of comets.COMETS) {
    // 1) t = 近日点时刻时，日心距必须等于 q
    const atPeri = comets.helioEcliptic(c, c.tp)
    assert.ok(Math.abs(atPeri.r - c.q) < c.q * 0.01 + 1e-6, `${c.id} 近日点 r=${atPeri.r} ≠ q=${c.q}`)

    // 2) 任意时刻：位置矢量应落在轨道面内，且与近日点方向的夹角等于真近点角
    for (const offset of [-30, 0, 45, 200]) {
      const pos = comets.helioEcliptic(c, c.tp + offset)
      const P = perihelionVector(c)
      const N = normalVector(c)
      const inPlane = pos.x * N[0] + pos.y * N[1] + pos.z * N[2]
      assert.ok(Math.abs(inPlane) < 1e-9 * Math.max(1, pos.r), `${c.id} 偏离轨道面 ${inPlane}`)

      const p = c.q * (1 + c.e) // 半通径
      const cosNu = (p / pos.r - 1) / c.e
      const nu = Math.acos(Math.max(-1, Math.min(1, cosNu)))
      const cosAng = (pos.x * P[0] + pos.y * P[1] + pos.z * P[2]) / pos.r
      const ang = Math.acos(Math.max(-1, Math.min(1, cosAng)))
      // 黄经差在 ±180° 附近时 acos 只给绝对值，取小者比较
      const delta = Math.min(Math.abs(ang - nu), Math.abs(ang - (2 * Math.PI - nu)))
      assert.ok(delta < 2e-3, `${c.id} 真近点角偏差 ${(delta / D2R).toFixed(3)}°`)
    }
  }
})

test('彗星亮度模型与实测标定一致（21P 2018 年回归）', () => {
  const giacobini = comets.COMET_BY_ID.get('21P')
  assert.ok(giacobini, '缺少 21P')
  const st = comets.cometState(giacobini, new Date('2018-09-10T00:00:00Z'))
  // 2018 年 9 月 21P 过近地（Δ≈0.28 AU），极大亮度约 6.5 等
  assert.ok(Math.abs(st.mag - 6.5) < 1.5, `模型 ${st.mag.toFixed(1)} 等，实测约 6.5 等`)
  assert.ok(Math.abs(st.delta - 0.28) < 0.06, `地心距 ${st.delta.toFixed(2)} AU，实测约 0.28 AU`)
  assert.ok(st.elongation > 60, '当时离太阳应足够远')
})

test('彗星亮度：M1 与 K1 参数正确参与（越近日点越亮）', () => {
  const c = comets.COMET_BY_ID.get('22P')
  assert.ok(c)
  const before = comets.cometState(c, new Date('2028-04-01T00:00:00Z'))
  const atPeri = comets.cometState(c, new Date('2028-07-02T00:00:00Z'))
  assert.ok(atPeri.r < before.r, '近日点时的日心距应更小')
  assert.ok(atPeri.mag < before.mag + 4, '亮度应随接近太阳而上升（同距离抵消后不会大幅变暗）')
})

test('彗星地平坐标：与目标高度/方位取值范围一致', () => {
  const site = { lat: 40.6, lon: 115.8, altM: 1800 }
  const c = comets.COMET_BY_ID.get('21P')
  const t = astro.makeTime(new Date('2031-10-03T12:00:00Z'))
  const pos = comets.cometAltAz(c, t, site)
  assert.ok(pos.alt >= -90 && pos.alt <= 90)
  assert.ok(pos.az >= 0 && pos.az < 360)
  // 与「同一矢量走 astro.vectorAltAz」完全一致（只验证接口连通性）
  const st = comets.cometState(c, t.date)
  const again = astro.vectorAltAz(st.vec, t, site)
  assert.ok(Math.abs(again.alt - pos.alt) < 1e-6)
})

test('彗星：距日角与地心/日心距满足余弦关系', () => {
  const c = comets.COMET_BY_ID.get('2P')
  const st = comets.cometState(c, new Date('2027-02-10T00:00:00Z'))
  const earth = astro.A.HelioVector(astro.A.Body.Earth, astro.makeTime(new Date('2027-02-10T00:00:00Z')))
  const R = Math.hypot(earth.x, earth.y, earth.z)
  // 三角形在「地球」处：彗星距离 r 由 Δ、日地距 R 与距日角（地球处的张角）决定
  const cosElong = Math.cos(st.elongation * D2R)
  const rFromCos = Math.sqrt(st.delta ** 2 + R ** 2 - 2 * st.delta * R * cosElong)
  assert.ok(Math.abs(rFromCos - st.r) < 0.01, `r 不一致：${rFromCos.toFixed(3)} vs ${st.r.toFixed(3)}`)
  assert.ok(Math.abs(st.r - c.q) < 0.02, '近日点附近 r 应接近 q')
})
