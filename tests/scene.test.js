/**
 * 地景建模：实测高程剖面 → 整圈天际线；名称关键字只决定剪影类型。
 * （天球投影与逐帧场景在 tests/sky.test.js）
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import * as catalog from '../lib/catalog.js'
import * as scene from '../lib/scene.js'

const SITE = catalog.SITE_BY_ID.get('haituo')

test('地景建模：名称关键字 → 剪影类型', () => {
  assert.equal(scene.classifyForeground('山脊松林').kind, 'ridge')
  assert.equal(scene.classifyForeground('海坨主峰').kind, 'ridge')
  assert.equal(scene.classifyForeground('湖湾').kind, 'water')
  assert.equal(scene.classifyForeground('高山草甸').kind, 'meadow')
  assert.equal(scene.classifyForeground('风车阵').kind, 'structure')
  assert.equal(scene.classifyForeground('盐湖倒影').kind, 'water', '「湖」先于「盐」命中')
  assert.equal(scene.classifyForeground('雅丹群').kind, 'desert')
  const d = scene.classifyForeground('不知名的机位')
  assert.ok(d.heightDeg > 0 && d.heightDeg <= 12)
  // 173 个站点全部能建模出至少一条剪影
  for (const site of catalog.SITES) {
    const models = scene.foregroundModels(site)
    assert.ok(models.length >= 1, `${site.name} 缺少地景模型`)
    assert.ok(models.every((m) => m.width > 0 && m.heightDeg > 0), `${site.name} 剪影高度无效`)
  }
})

test('高程库：覆盖全部站点，剖面为 36 点、单位度', () => {
  const info = scene.HORIZON_INFO
  assert.ok(info, '应有 lib/data/horizon.json')
  assert.match(String(info.source), /terrain-tiles|DEM/i)
  assert.equal(info.step, 10)
  assert.ok(info.sites >= catalog.SITES.length, `覆盖 ${info.sites}/${catalog.SITES.length} 站`)
  for (const site of catalog.SITES) {
    const prof = scene.horizonProfile(site)
    assert.ok(prof, `${site.name} 缺少高程剖面`)
    assert.equal(prof.n.length, 36)
    assert.equal(prof.f.length, 36)
    for (const v of [...prof.n, ...prof.f]) assert.ok(v >= -6 && v <= 45, `${site.name} 剖面高度 ${v}`)
  }
})

test('天际线：高度来自实测剖面（有起伏、可复现），不是凭空的三角尖', () => {
  const line = scene.skyline(SITE)
  assert.equal(line.source, 'dem')
  assert.equal(line.near.length, 360)
  assert.equal(line.far.length, 360)
  const n = line.near.map((p) => p[1])
  assert.ok(Math.max(...n) - Math.min(...n) > 3, '山区站点必须有起伏')
  // 1° 插值后仍然连续：相邻点跳变不超过 1.5°
  for (let i = 1; i < n.length; i += 1) {
    assert.ok(Math.abs(n[i] - n[i - 1]) < 1.5, `方位 ${i}° 跳变 ${(n[i] - n[i - 1]).toFixed(2)}°`)
  }
  assert.ok(line.relief > 0)
  // 同一站点反复计算结果完全一致（动画不会抖动）
  const again = scene.skyline(SITE)
  assert.deepEqual(again.near, line.near)
  // 平原站点的高度明显低于山区站点
  const plain = catalog.SITE_BY_ID.get('hulunbuir')
  const flat = scene.skyline(plain)
  assert.ok(flat.relief < line.relief, `平原 ${flat.relief}° 应低于山区 ${line.relief}°`)
})

test('地形剪影兜底：窗口内取高度、窗口外为 0、且确定性可复现', () => {
  const models = scene.foregroundModels(SITE)
  const seed = scene.seedOf(SITE)
  assert.ok(seed >= 0 && seed < 10)
  const inRidge = scene.horizonAt(models, 320, seed)
  assert.ok(inRidge > 0 && inRidge < 20, `山脊方向 ${inRidge}`)
  assert.equal(scene.horizonAt(models, 180, seed), 0, '南向没有地景 → 地平线为 0')
  assert.equal(scene.horizonAt(models, 320, seed), inRidge)
  assert.equal(scene.horizonAt(models, 320, seed), inRidge)
})
