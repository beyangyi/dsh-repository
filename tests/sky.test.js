/**
 * 画面模拟 v2：星表、赤道→地平、逐帧 sim（行星/日月/流星/彗尾）与浏览器渲染器。
 * 渲染器只在 Node 里用「记录调用的假 canvas」跑，验证它画了该画的东西、且不抛错。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import * as astro from '../lib/astro.js'
import * as catalog from '../lib/catalog.js'
import * as skyview from '../lib/skyview.js'
import { meta, search } from '../lib/planner.js'

const D2R = Math.PI / 180
const R2D = 180 / Math.PI
const SITE = catalog.SITE_BY_ID.get('haituo')
const M31 = catalog.TARGET_BY_ID.get('m31')

/** 两个赤道坐标的角距（度）。 */
function sepDeg([ra1, dec1], [ra2, dec2]) {
  const a = Math.cos(dec1 * D2R) * Math.cos(ra1 * D2R)
  const b = Math.cos(dec1 * D2R) * Math.sin(ra1 * D2R)
  const c = Math.sin(dec1 * D2R)
  const d = Math.cos(dec2 * D2R) * Math.cos(ra2 * D2R)
  const e = Math.cos(dec2 * D2R) * Math.sin(ra2 * D2R)
  const f = Math.sin(dec2 * D2R)
  return Math.acos(Math.max(-1, Math.min(1, a * d + b * e + c * f))) / D2R
}

function renderer() {
  // eslint-disable-next-line no-new-func
  return new Function(`${skyview.RENDER_SRC}; return { skyRender, skyEqToAltAz, skyProject, skyBasis, skyVec };`)()
}

function stubCtx(calls) {
  const ctx = {
    gradients: [],
    createLinearGradient: () => {
      const g = { stops: [], addColorStop(o, c) { g.stops.push([o, c]) } }
      ctx.gradients.push(g)
      return g
    },
    createRadialGradient: () => ({ addColorStop() {} }),
    fillRect: (...a) => calls.push(['fillRect', ...a]),
    strokeRect: (...a) => calls.push(['strokeRect', ...a]),
    fillText: (t, x, y) => calls.push(['text', t, x, y]),
    beginPath: () => calls.push(['path']),
    closePath() {},
    moveTo: (x, y) => calls.push(['move', x, y]),
    lineTo: (x, y) => calls.push(['line', x, y]),
    arc: () => calls.push(['arc']),
    fill: (rule) => calls.push(['fill', ctx.globalCompositeOperation, rule, ctx.fillStyle]),
    stroke: () => calls.push(['stroke', ctx.globalCompositeOperation, ctx.strokeStyle, ctx.lineWidth]),
    save() {},
    restore() {},
    clip: () => calls.push(['clip']),
    setLineDash() {},
    rect: () => calls.push(['rect']),
  }
  return ctx
}

test('星表：亮星数量、星等上限与中文名', () => {
  const sky = skyview.skyMeta()
  assert.ok(sky.stars.length >= 400 && sky.stars.length <= 900, `亮星 ${sky.stars.length} 颗`)
  assert.ok(sky.stars.every(([ra, dec, mag]) => ra >= 0 && ra < 360 && dec >= -90 && dec <= 90 && mag <= 4.2))
  const named = sky.stars.filter(([, , , name]) => name).length
  assert.ok(named / sky.stars.length > 0.8, `中文名覆盖 ${named}/${sky.stars.length}`)
  // 最亮的几颗必须在
  const names = sky.stars.map((s) => s[3])
  for (const want of ['天狼', '织女', '大角', '五车二']) {
    assert.ok(names.includes(want), `缺少 ${want}`)
  }
})

test('星表：星座连线有中文名、每条折线至少两点', () => {
  const sky = skyview.skyMeta()
  assert.ok(sky.lines.length >= 40, `星座 ${sky.lines.length} 个`)
  for (const line of sky.lines) {
    assert.ok(line.n && line.n !== line.id, '星座应有中文名')
    assert.ok(line.paths.length >= 1)
    for (const path of line.paths) {
      assert.ok(path.length >= 2, `${line.n} 的折线点数不足`)
      for (const [ra, dec] of path) assert.ok(ra >= 0 && ra < 360 && Math.abs(dec) <= 90)
    }
  }
  assert.ok(sky.lines.some((l) => l.n === '猎户座'), '应有猎户座')
})

test('黄道：72 个点，落在黄道上（与太阳一年的赤纬范围一致）', () => {
  const ec = skyview.eclipticPoints()
  assert.equal(ec.length, 72)
  const decs = ec.map((p) => p[1])
  assert.ok(Math.max(...decs) > 23 && Math.max(...decs) < 24)
  assert.ok(Math.min(...decs) < -23 && Math.min(...decs) > -24)
})

test('赤道→地平：与 astro.altAzFromHA 一致（该函数含大气折射，容差 0.08°）', () => {
  const lsts = [0, 3.7, 9.2, 15.5, 21.9]
  const lats = [18, 30, 40, 50]
  for (const lat of lats) {
    for (const lst of lsts) {
      for (const [ra, dec] of [[0, 0], [101.287, -16.716], [279.235, 38.784], [45, 60], [300, -40]]) {
        const mine = skyview.eqToAltAz(ra, dec, lst, lat)
        const ref = astro.altAzFromHA(ra, dec, lst, lat)
        // 地平线附近折射可达 0.5°，高高度处只剩 0.02° 左右
        const tol = mine.alt > 20 ? 0.05 : 0.6
        assert.ok(Math.abs(mine.alt - ref.alt) < tol, `alt ${mine.alt} vs ${ref.alt}`)
        const dAz = Math.abs(((mine.az - ref.az + 540) % 360) - 180)
        assert.ok(dAz < 0.05, `az ${mine.az} vs ${ref.az}`)
      }
    }
  }
})

test('sim v3：结构、帧数、相机、扩展时段与整圈地景', () => {
  const start = astro.localDate('2027-03-10', '21:50')
  const end = astro.localDate('2027-03-11', '02:10')
  const sim = skyview.buildSim({
    item: { start, end, target: M31, site: SITE },
    target: M31,
    site: SITE,
    params: { ffFocalMid: 200, trackerNeeded: true },
  })
  assert.equal(sim.version, 3)
  assert.equal(sim.sky, 'night')
  assert.ok(sim.frames.length >= 5 && sim.frames.length <= 73, `帧数 ${sim.frames.length}`)
  // 区间向两侧各扩 6 h
  assert.equal(sim.window.start, '21:50')
  assert.equal(sim.window.end, '02:10')
  assert.equal(sim.frames[0].t, '15:50')
  assert.equal(sim.frames[sim.frames.length - 1].t, '08:10')
  assert.equal(sim.frames[0].d, '03-10', '帧要带月-日')
  assert.equal(sim.frames[sim.frames.length - 1].d, '03-11', '跨零点日期要变')
  // 最佳时段内的帧被标出来（帧按整段等分，窗口边界附近可能差一个步长）
  const inWin = sim.frames.filter((f) => f.w === 1)
  assert.ok(inWin.length > 10, `窗口内帧数 ${inWin.length}`)
  const mins = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))
  assert.ok(Math.abs(mins(inWin[0].t) - mins('21:50')) <= 12, `窗口首帧 ${inWin[0].t}`)
  assert.ok(Math.abs(mins(inWin[inWin.length - 1].t) - mins('02:10')) <= 12, `窗口末帧 ${inWin[inWin.length - 1].t}`)
  // 逐帧太阳高度：两端是白天、中间是夜
  assert.ok(sim.frames[0].sun > 10, `起点太阳高度 ${sim.frames[0].sun}`)
  assert.ok(inWin[0].sun < -10, `窗口内太阳高度 ${inWin[0].sun}`)
  assert.equal(sim.targets.length, 1)
  assert.ok(sim.camera.yaw >= 0 && sim.camera.yaw < 360)
  assert.ok(sim.camera.pitch >= 0 && sim.camera.pitch <= 90)
  assert.equal(sim.camera.tracker, true)
  assert.ok(sim.camera.fovH > 0 && sim.camera.fovV > 0)
  // 地形剪影：整圈 360 点（1° 步长），方位 0…359 单调；高度来自实测高程剖面，每点带类型码
  assert.equal(sim.ridge.length, 360)
  assert.equal(sim.ridgeFar.length, 360)
  assert.equal(sim.terrainSource, 'dem', '天际线应来自实测高程剖面')
  assert.equal(sim.ridge[0][0], 0)
  assert.ok(sim.ridge[359][0] > 355)
  assert.ok(sim.ridge.every((p) => Number.isInteger(p[2]) && p[2] >= 0 && p[2] <= 5), '地景类型码 0–5')
  assert.ok(Number.isFinite(sim.reliefDeg) && sim.reliefDeg > 0, '应给出地形最高点')
  let prev = -Infinity
  let lo = 90
  let hi = -90
  for (let i = 0; i < sim.ridge.length; i += 1) {
    const [az, alt] = sim.ridge[i]
    assert.ok(az > prev, 'ridge 方位应单调递增')
    prev = az
    assert.ok(alt >= -6 && alt <= 45, `近景高度 ${alt}`)
    assert.ok(sim.ridgeFar[i][1] >= -6 && sim.ridgeFar[i][1] <= 45, `远景高度 ${sim.ridgeFar[i][1]}`)
    lo = Math.min(lo, alt, sim.ridgeFar[i][1])
    hi = Math.max(hi, alt, sim.ridgeFar[i][1])
  }
  // 真实地形必须有起伏（不是一条直线），海坨山在山区
  assert.ok(hi - lo > 3, `天际线起伏 ${(hi - lo).toFixed(1)}°`)
  // 每帧都有恒星时与目标坐标
  for (const f of sim.frames) {
    assert.ok(f.lst >= 0 && f.lst < 24)
    assert.match(f.d, /^\d\d-\d\d$/)
    assert.equal(f.tp.length, 1)
    for (const [ra, dec] of f.tp) assert.ok(ra >= 0 && ra < 360 && Math.abs(dec) <= 90)
  }
})

test('sim v3：日月带真实视直径（0.48°–0.56°）', () => {
  const start = astro.localDate('2027-03-10', '18:00')
  const end = astro.localDate('2027-03-10', '23:00')
  const sun = { type: 'solarEclipse', name: '日食', body: 'Sun', raH: null, dec: null }
  const sim = skyview.buildSim({ item: { start, end, target: sun, site: SITE }, target: sun, site: SITE, params: {} })
  assert.ok(sim)
  const sunAlt = sim.frames[0].bodies.find(([,, bi]) => sim.bodyNames[bi] === '太阳')
  assert.ok(sunAlt, '白天帧应有太阳')
  assert.ok(sunAlt[3] > 0.5 && sunAlt[3] < 0.56, `太阳视直径 ${sunAlt[3]}`)
  const moonSize = sim.frames[0].moon ? sim.frames[0].moon[3] : null
  if (moonSize) assert.ok(moonSize > 0.45 && moonSize < 0.6, `月亮视直径 ${moonSize}`)
})

test('sim v2：行星与日月只列地平线以上，且坐标能反算回高度', async () => {
  const r = await search({ eventType: 'planet', dateStart: '2027-03-10', dateEnd: '2027-03-12', siteLimit: 3, withSim: true, limit: 1 })
  assert.ok(r.ok, r.message)
  const sim = r.ranked[0].sim
  assert.ok(sim.frames[0].bodies.length >= 1, '应有行星')
  for (const f of sim.frames) {
    for (const [ra, dec, bi] of f.bodies) {
      const p = skyview.eqToAltAz(ra, dec, f.lst, sim.lat)
      assert.ok(p.alt > -3, `第 ${bi} 颗在地平线下 ${p.alt}`)
      assert.ok(sim.bodyNames[bi], 'bodies 的下标要能对上 bodyNames')
    }
  }
})

test('sim v2：流星从辐射点向外发散', async () => {
  const r = await search({ eventType: 'meteor', location: '海坨山', dateStart: '2026-12-14', dateEnd: '2026-12-14', withSim: true, limit: 1 })
  assert.ok(r.ok, r.message)
  const sim = r.ranked[0].sim
  assert.ok(sim.radiant, '流星雨应有辐射点')
  const all = sim.frames.flatMap((f) => f.meteors)
  assert.ok(all.length > 8, `流星线段 ${all.length} 条`)
  for (const [ra1, dec1, ra2, dec2] of all) {
    const d1 = sepDeg(sim.radiant, [ra1, dec1])
    const d2 = sepDeg(sim.radiant, [ra2, dec2])
    assert.ok(d2 > d1, `流星应向外飞：${d1.toFixed(1)}° → ${d2.toFixed(1)}°`)
    assert.ok(d1 < 40, '流星不应离辐射点太远')
  }
})

test('sim v2：彗尾背向太阳、长度 1.5°–25°', async () => {
  const r = await search({ eventType: 'comet', dateStart: '2028-05-20', dateEnd: '2028-06-10', withSim: true, limit: 1 })
  assert.ok(r.ok, r.message)
  const sim = r.ranked[0].sim
  const frames = sim.frames.filter((f) => f.comet)
  assert.ok(frames.length > 0, '应有彗星帧')
  const time = astro.makeTime(astro.localDate('2028-05-25', '23:00'))
  const observer = astro.observerOf(SITE)
  for (const f of frames.slice(0, 5)) {
    assert.ok(f.comet.deg >= 1.5 && f.comet.deg <= 25, `尾长 ${f.comet.deg}`)
    // 彗尾背日：尾尖比彗头离太阳更远
    const sun = astro.A.Equator(astro.A.Body.Sun, time, observer, true, true)
    const sunRaDec = [sun.ra * 15, sun.dec]
    const head = sepDeg(sunRaDec, f.comet.head)
    const tip = sepDeg(sunRaDec, f.comet.tip)
    assert.ok(tip > head, `尾尖应更远离太阳：${head.toFixed(2)}° → ${tip.toFixed(2)}°`)
  }
})

test('渲染器：地平线裁剪、方位字、HUD 与月亮视直径', async () => {
  const r = await search({ eventType: 'deepseek', location: '海坨山', dateStart: '2027-03-10', dateEnd: '2027-03-10', withSim: true, limit: 1 })
  assert.ok(r.ok, r.message)
  const sim = r.ranked[0].sim
  const sky = skyview.skyMeta()
  const fn = renderer()

  const calls = []
  const ctx = stubCtx(calls)
  const winK = sim.frames.findIndex((f) => f.w === 1)
  // 默认视角把目标放在正中，仰角较高、地平线可能出画；这里把机位压低到 20°，
  // 用 100° 视野让地平线和方位字进画面（裁剪、方位字本身的行为不变）
  fn.skyRender(ctx, { sim, sky, free: true, camera: { ...sim.camera, fov: 100, pitch: 20 }, w: 960, h: 540 }, winK)
  assert.ok(calls.some((c) => c[0] === 'clip'), '天空应裁剪在地景以上')
  assert.ok(calls.some((c) => c[0] === 'fillRect'), '应铺天空渐变')
  const texts = calls.filter((c) => c[0] === 'text').map((c) => c[1])
  const dirs = texts.filter((t) => ['北', '东', '南', '西'].includes(t))
  assert.ok(dirs.length >= 1, '应标方位字（地平线上的东南西北）')
  assert.ok(texts.some((t) => /^\d\d-\d\d \d\d:\d\d /.test(t)), `左上时间应带月日，实际 ${texts.slice(0, 6).join('|')}`)
  assert.ok(texts.some((t) => String(t).includes('最佳时段内')), '窗口内的帧应标注')
  assert.ok(texts.some((t) => String(t).startsWith('高度角')), '左下应显示高度角')
  assert.ok(texts.some((t) => String(t).startsWith('北纬')), '左下应显示经纬度')
  assert.ok(texts.some((t) => String(t).includes('地平坐标')), '右上应显示坐标系')
  assert.ok(texts.some((t) => String(t).includes('视野')), '右上应显示视野')
})

test('渲染器：银河与星点按视野绘制，缩放后星更多', async () => {
  const r = await search({ eventType: 'milkyway', location: '海坨山', dateStart: '2027-07-10', dateEnd: '2027-07-10', withSim: true, limit: 1 })
  assert.ok(r.ok, r.message)
  const sim = r.ranked[0].sim
  const sky = skyview.skyMeta()
  const fn = renderer()

  const wide = []
  const winK = sim.frames.findIndex((f) => f.w === 1)
  fn.skyRender(stubCtx(wide), { sim, sky, camera: { ...sim.camera, fov: 100 }, w: 960, h: 540 }, winK)
  const zoom = []
  fn.skyRender(stubCtx(zoom), { sim, sky, camera: { ...sim.camera, fov: 30 }, w: 960, h: 540 }, winK)
  assert.ok(wide.filter((c) => c[0] === 'fill').length > 5, '应画银河等值线多边形')
  assert.ok(wide.filter((c) => c[0] === 'line').length > 50, '应画网格/星座连线')
  assert.ok(wide.filter((c) => c[0] === 'arc').length > 20, '应画星点')
  // 视野缩小 → 同样的天区被放大，星点半径/数量随之变化（至少不应更少）
  assert.ok(zoom.filter((c) => c[0] === 'arc').length > 5, '缩放后仍应画星点')
  // 赤道坐标模式：出现赤经/赤纬读数与网格
  const eqCalls = []
  fn.skyRender(stubCtx(eqCalls), { sim, sky, camera: sim.camera, mode: 'eq', w: 960, h: 540 }, winK)
  const eqTexts = eqCalls.filter((c) => c[0] === 'text').map((c) => c[1])
  assert.ok(eqTexts.some((t) => String(t).includes('赤道坐标')), '应显示赤道坐标模式')
  assert.ok(eqTexts.some((t) => String(t).startsWith('赤经')), '左下应补赤经赤纬')
})

test('渲染器：晨昏亮度随太阳高度变化', async () => {
  const fn = renderer()
  const sky = skyview.skyMeta()
  const mk = (sunAlt) => ({
    version: 3, sky: sunAlt < -18 ? 'night' : (sunAlt < -6 ? 'twilight' : 'day'),
    lat: 40, lon: 116, targets: [], bodyNames: [], palettes: {
      night: { gradient: ['#000010', '#000020', '#000030'], ground: '#000', label: '#fff' },
      twilight: { gradient: ['#201030', '#603040', '#c06040'], ground: '#100', label: '#fc9' },
      day: { gradient: ['#3060c0', '#80b0e0', '#d0e0f0'], ground: '#222', label: '#012' },
    },
    camera: { yaw: 0, pitch: 30, fov: 100, tracker: false, fovH: 10, fovV: 7, focal: 200 },
    ridge: Array.from({ length: 120 }, (_, i) => [(360 * i) / 120, 2]),
    ridgeFar: Array.from({ length: 120 }, (_, i) => [(360 * i) / 120, 1]),
    foregrounds: [],
    frames: [{ t: '22:00', d: '03-10', lst: 0, sun: sunAlt, w: 1, tp: [], bodies: [], moon: null, comet: null, meteors: [] }],
  })
  const gradOf = (sun) => {
    const calls = []
    fn.skyRender(stubCtx(calls), { sim: mk(sun), sky, camera: mk(sun).camera, w: 480, h: 270 }, 0)
    return calls.find((c) => c[0] === 'fillRect')
  }
  // 夜 vs 白天：天空渐变的填充参数不同（色板插值生效）
  const night = gradOf(-30)
  const day = gradOf(30)
  assert.ok(night && day)
  const textsOf = (sun) => {
    const calls = []
    fn.skyRender(stubCtx(calls), { sim: mk(sun), sky, camera: mk(sun).camera, w: 480, h: 270 }, 0)
    return calls.filter((c) => c[0] === 'text').map((c) => c[1])
  }
  assert.ok(textsOf(-30).some((t) => String(t).includes('夜间')), '夜间应标注')
  assert.ok(textsOf(-10).some((t) => String(t).includes('晨昏')), '晨昏应标注')
  assert.ok(textsOf(30).some((t) => String(t).includes('白天')), '白天应标注')
})

test('渲染器：地景以下的星不画', () => {
  const fn = renderer()
  // 合成一份 sim：地景整圈 10°，一颗星在高度 5°、一颗在 40°
  const sim = {
    version: 3, sky: 'night', lat: 40, lon: 116, targets: [], bodyNames: [],
    palette: { gradient: ['#000', '#000', '#000'], ground: '#000', label: '#fff' },
    camera: { yaw: 180, pitch: 30, fov: 100, tracker: false, fovH: 10, fovV: 7, focal: 200 },
    ridge: Array.from({ length: 120 }, (_, i) => [(360 * i) / 120, 10]),
    ridgeFar: Array.from({ length: 120 }, (_, i) => [(360 * i) / 120, 6]),
    foregrounds: [],
    frames: [{
      t: '22:00', d: '03-10', lst: 0, tp: [], bodies: [], moon: null, comet: null, meteors: [],
    }],
  }
  // 用星表里真实存在的坐标太麻烦：直接构造两颗「星」放到 sky 里，
  // 赤经取 0（lst=0 时正好在子午圈上），赤纬 20° → 高度 70°，赤纬 −70° → 地平线下。
  const sky = {
    stars: [[0, 0, 1.0, '测试星'], [0, -70, 1.0, '地景下星']],
    lines: [], ecliptic: [], milkyway: { band: [], core: [] },
  }
  const calls = []
  fn.skyRender(stubCtx(calls), { sim, sky, camera: sim.camera, w: 480, h: 270 }, 0)
  const texts = calls.filter((c) => c[0] === 'text').map((c) => c[1])
  const arcs = calls.filter((c) => c[0] === 'arc').length
  // 只应该画出地平线以上的那颗（另有一颗在背面/地景下）
  assert.ok(texts.filter((t) => t === '测试星').length <= 1)
  assert.ok(!texts.includes('地景下星'), '地景以下的星不应标注')
  assert.ok(arcs >= 1, '地平线以上的星应画出')
})

test('渲染器：流星雨有辐射点标记，彗星帧不抛错', async () => {
  const fn = renderer()
  const meteor = await search({ eventType: 'meteor', location: '海坨山', dateStart: '2026-12-14', dateEnd: '2026-12-14', withSim: true, limit: 1 })
  const mSim = meteor.ranked[0].sim
  const mCalls = []
  const mCtx = stubCtx(mCalls)
  for (let k = 0; k < mSim.frames.length; k += 1) {
    fn.skyRender(mCtx, { sim: mSim, sky: skyview.skyMeta(), camera: mSim.camera, w: 480, h: 270 }, k)
  }
  assert.ok(mCalls.some((c) => c[0] === 'text' && c[1] === '辐射点'), '应标注辐射点')

  const comet = await search({ eventType: 'comet', dateStart: '2028-05-20', dateEnd: '2028-06-10', withSim: true, limit: 1 })
  const cSim = comet.ranked[0].sim
  const cCalls = []
  const cCtx = stubCtx(cCalls)
  assert.doesNotThrow(() => {
    for (let k = 0; k < cSim.frames.length; k += 1) {
      fn.skyRender(cCtx, { sim: cSim, sky: skyview.skyMeta(), camera: cSim.camera, w: 480, h: 270 }, k)
    }
  })
})

test('渲染器的赤道→地平与服务端一致', () => {
  const fn = renderer()
  for (const lst of [0, 5.5, 13.2, 22.8]) {
    for (const [ra, dec] of [[10, 20], [200, -30], [300, 70]]) {
      const a = fn.skyEqToAltAz(ra, dec, lst, 40)
      const b = skyview.eqToAltAz(ra, dec, lst, 40)
      assert.ok(Math.abs(a.alt - b.alt) < 1e-9 && Math.abs(a.az - b.az) < 1e-9)
    }
  }
})

test('meta.sky：页面一次性拿到星表、星座与黄道', () => {
  const m = meta()
  assert.ok(m.sky && m.sky.stars.length > 100)
  assert.ok(m.sky.lines.length > 40)
  assert.equal(m.sky.ecliptic.length, 72)
})

test('sim：默认帧是最佳时段开始，视场按类型给', async () => {
  const deep = await search({ eventType: 'deepsky', location: '海坨山', dateStart: '2027-03-10', dateEnd: '2027-03-10', withSim: true, limit: 1 })
  const s = deep.ranked[0].sim
  assert.equal(s.startIndex, s.frames.findIndex((f) => f.w === 1), 'startIndex 必须指向窗口内首帧')
  assert.ok(s.startIndex > 0, '扩展区间开头在窗口之前')
  assert.equal(s.frame, undefined)
  // 各类型默认视场
  assert.equal(skyview.defaultFov({ type: 'planet' }, 200), 18)
  assert.equal(skyview.defaultFov({ type: 'meteor' }, 20), 110)
  assert.equal(skyview.defaultFov({ type: 'milkyway' }, 20), 120)
  assert.equal(skyview.defaultFov({ type: 'lunarEclipse' }, 500), 20)
  assert.equal(skyview.defaultFov({ type: 'deepsky' }, 500), 40)
  assert.equal(skyview.defaultFov({ type: 'deepsky' }, 135), 60)
})

test('夜间底色比银河暗（各波特尔等级）', () => {
  const lum = (hex) => {
    const n = parseInt(hex.slice(1), 16)
    return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)
  }
  for (let bortle = 1; bortle <= 9; bortle += 1) {
    const p = skyview.paletteOf('night', bortle)
    for (const stop of p.gradient) {
      const bg = lum(stop)
      // 银河最暗一级 alpha 0.10、颜色 #ced9f2
      const blended = bg * 0.9 + lum('#ced9f2') * 0.1
      assert.ok(bg <= 40, `B${bortle} 夜空底色太亮：${stop} → ${bg.toFixed(1)}`)
      assert.ok(blended - bg >= 8, `B${bortle} 银河应比底色亮：${stop} → +${(blended - bg).toFixed(1)}`)
    }
  }
})

test('立体投影：整幅画面都是天区，圆盘恒内切对角线（没有圆形取景框）', () => {
  const fn = renderer()
  const diag = Math.hypot(960, 540) / 2
  for (const fov of [5, 20, 40, 95, 120, 170, 180]) {
    const b = fn.skyBasis({ yaw: 0, pitch: 30, fov }, 960, 540)
    assert.ok(Math.abs(b.R - diag) < 1e-9, `${fov}° 圆盘应内切对角线，实际 ${b.R}`)
    // 四角恰好落在视场半径（fov/2）上，所以画面每个像素都能投影，不会出现空洞
    const cornerDeg = (2 * Math.atan(diag / b.k)) / D2R
    assert.ok(Math.abs(cornerDeg - fov / 2) < 1e-6, `${fov}° 画面四角应为 ${fov / 2}°，实际 ${cornerDeg}`)
    assert.ok(Math.cos(cornerDeg * D2R) > -1e-9, `${fov}° 四角仍在可投影半球内`)
  }
  // 180°：四角正好 90°，d = 0，仍然要投得出来（不能返回 null）
  const b180 = fn.skyBasis({ yaw: 0, pitch: 0, fov: 180 }, 960, 540)
  assert.ok(Math.abs((2 * Math.atan(diag / b180.k)) / D2R - 90) < 1e-6)
  // 画面右上角的方向：水平 480、垂直 270（d = 0 的极限）
  const corner = [480 / diag, 0, 270 / diag]
  const qCorner = fn.skyProject(corner, b180, 960, 540)
  assert.ok(qCorner, '180° 时画面四角（距中心 90°）应可投影')
  assert.ok(Math.abs(qCorner.x - 1) < 0.02 && Math.abs(qCorner.y) < 0.02, `四角应落在画布角上：${qCorner.x.toFixed(3)}, ${qCorner.y.toFixed(3)}`)
  // 距中心 θ 的点落在 k·tan(θ/2) 像素处
  const b = fn.skyBasis({ yaw: 0, pitch: 0, fov: 120 }, 960, 540)
  for (const th of [5, 15, 25, 33]) {
    const q = fn.skyProject(fn.skyVec(th, 0), b, 960, 540)
    assert.ok(q, `${th}° 应可见`)
    const rPx = Math.hypot((q.x - 0.5) * 960, (q.y - 0.5) * 540)
    const want = b.k * Math.tan((th / 2) * D2R)
    assert.ok(Math.abs(rPx - want) < 0.7, `${th}° → ${rPx.toFixed(1)} vs ${want.toFixed(1)}`)
  }
})

test('背景明暗跟地平高度走：同一帧拖动俯仰不会时深时浅', () => {
  const fn = renderer()
  const palettes = {
    night: { gradient: ['#02040a', '#0a1220', '#1a2133'], ground: '#05070c', label: '#cfe0f7' },
    twilight: { gradient: ['#1b2340', '#4a3f63', '#b06a4a'], ground: '#0a0c12', label: '#ffd9a8' },
    day: { gradient: ['#3f74c9', '#7aa8e6', '#cfe0f5'], ground: '#28313a', label: '#10305c' },
  }
  const simAt = (pitch) => ({
    version: 3, sky: 'night', lat: 40, lon: 116, targets: [], bodyNames: [], palettes,
    camera: { yaw: 0, pitch, fov: 100, tracker: false, fovH: 10, fovV: 7, focal: 200 },
    ridge: Array.from({ length: 360 }, (_, i) => [i, 2, 0]),
    ridgeFar: Array.from({ length: 360 }, (_, i) => [i, 1, 0]),
    foregrounds: [],
    frames: [{ t: '22:00', d: '03-10', lst: 0, sun: -30, w: 1, tp: [], bodies: [], moon: null, comet: null, meteors: [] }],
  })
  const skyStopOf = (pitch) => {
    const sim = simAt(pitch)
    const ctx = stubCtx([])
    fn.skyRender(ctx, { sim, sky: { stars: [], lines: [], ecliptic: [], milkyway: [] }, camera: sim.camera, w: 960, h: 540 }, 0)
    const grad = ctx.gradients[0]
    assert.ok(grad.stops.length >= 5, '天空渐变应按高度插值（多段）')
    return grad.stops
  }
  const lum = (hex) => {
    const n = parseInt(hex.slice(1), 16)
    return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)
  }
  const low = skyStopOf(20)
  const high = skyStopOf(62)
  // 抬到 62° 时画面顶端接近天顶，颜色必然比 20° 时更暗
  assert.ok(lum(high[0][1]) < lum(low[0][1]), `俯仰 62° 顶端 ${high[0][1]} 应比 20° ${low[0][1]} 更暗`)
  // 同一俯仰反复渲染结果一致
  assert.deepEqual(skyStopOf(20), low)
})

test('银河用加色绘制：任何视角都不会比天空暗', () => {
  const fn = renderer()
  const sim = {
    version: 3, sky: 'night', lat: 40, lon: 116, targets: [], bodyNames: [],
    palettes: {
      night: { gradient: ['#02040a', '#0a1220', '#1a2133'], ground: '#05070c', label: '#cfe0f7' },
      twilight: { gradient: ['#1b2340', '#4a3f63', '#b06a4a'], ground: '#0a0c12', label: '#ffd9a8' },
      day: { gradient: ['#3f74c9', '#7aa8e6', '#cfe0f5'], ground: '#28313a', label: '#10305c' },
    },
    camera: { yaw: 180, pitch: 30, fov: 100, tracker: false, fovH: 10, fovV: 7, focal: 200 },
    ridge: Array.from({ length: 360 }, (_, i) => [i, 1, 0]),
    ridgeFar: Array.from({ length: 360 }, (_, i) => [i, 0.5, 0]),
    foregrounds: [],
    frames: [{ t: '22:00', d: '03-10', lst: 0, sun: -30, w: 1, tp: [], bodies: [], moon: null, comet: null, meteors: [] }],
  }
  const sky = {
    stars: [], lines: [], ecliptic: [],
    milkyway: [{ level: 3, polys: [[[[0, 0], [20, 0], [20, 15], [0, 15]]]] }],
  }
  const calls = []
  fn.skyRender(stubCtx(calls), { sim, sky, camera: sim.camera, w: 960, h: 540 }, 0)
  const mwFills = calls.filter((c) => c[0] === 'fill' && c[1] === 'lighter')
  assert.ok(mwFills.length >= 1, '银河必须在 lighter 混合模式下填充')
  assert.ok(mwFills.every((c) => c[2] === 'evenodd'), '银河多边形仍用 even-odd 挖洞')
})

test('银河：嵌套等值线只叠加相邻两级的差，核心不会叠成白光束', () => {
  const fn = renderer()
  const base = {
    version: 3, sky: 'night', lat: 40, lon: 116, targets: [], bodyNames: [],
    palettes: {
      night: { gradient: ['#02040a', '#0a1220', '#1a2133'], ground: '#05070c', label: '#cfe0f7' },
      twilight: { gradient: ['#1b2340', '#4a3f63', '#b06a4a'], ground: '#0a0c12', label: '#ffd9a8' },
      day: { gradient: ['#3f74c9', '#7aa8e6', '#cfe0f5'], ground: '#28313a', label: '#10305c' },
    },
    camera: { yaw: 180, pitch: 30, fov: 120, tracker: false, fovH: 10, fovV: 7, focal: 200 },
    ridge: Array.from({ length: 360 }, (_, i) => [i, 1, 0]),
    ridgeFar: Array.from({ length: 360 }, (_, i) => [i, 0.5, 0]),
    foregrounds: [],
    frames: [{ t: '22:00', d: '03-10', lst: 0, sun: -30, w: 1, tp: [], bodies: [], moon: null, comet: null, meteors: [] }],
  }
  // 五级同心方框，模拟真实银河等值线的嵌套关系（第 0 级是弥散光晕，不画）
  const levels = [0, 1, 2, 3, 4].map((lv) => ({
    level: lv,
    polys: [[[[0, 0], [24 - lv * 4, 0], [24 - lv * 4, 16 - lv * 3], [0, 16 - lv * 3]]]],
  }))
  const calls = []
  fn.skyRender(
    stubCtx(calls),
    { sim: base, sky: { stars: [], lines: [], ecliptic: [], milkyway: levels }, camera: base.camera, w: 960, h: 540 },
    0,
  )
  const alphas = calls
    .filter((c) => c[0] === 'fill' && c[1] === 'lighter')
    .map((c) => Number((/rgba\(206,217,242,([\d.]+)\)/.exec(c[3]) || [])[1]))
  // 五级环带各一笔：最外圈极淡，往里逐级变亮
  assert.equal(alphas.length, 5, `五级环带各画一笔，实际 ${alphas.length}`)
  assert.deepEqual(alphas, [0.01, 0.06, 0.05, 0.05, 0.05], '第 0 级最淡，第 1 级起是银河带')
  const total = alphas.reduce((a, b) => a + b, 0)
  assert.ok(total <= 0.24 && total > 0.18, `核心累计 alpha 应在 0.18–0.24 之间，实际 ${total.toFixed(2)}`)
  assert.ok(alphas[0] * 3 < alphas[1], '最外圈薄雾必须远暗于银河带')
  // 全部走加色混合：只会比夜空亮，不会变暗
  const mwFills = calls.filter((c) => c[0] === 'fill' && /rgba\(206,217,242/.test(String(c[3])))
  assert.equal(mwFills.filter((c) => c[1] === 'lighter').length, mwFills.length, '银河填充必须全部是加色')
  // 不再有宽描边（那正是 180° 花屏的来源）
  const wide = calls.filter((c) => c[0] === 'stroke' && c[3] > 12)
  assert.equal(wide.length, 0, `不应有宽描边，实际 ${wide.length}`)
})

test('180° 视场不花屏：没有任何宽描边，银河五级仍照常填充', () => {
  const fn = renderer()
  const sky = skyview.skyMeta()
  const make = (fov) => ({
    version: 3, sky: 'night', lat: 28.14, lon: 86.85, targets: [], bodyNames: [],
    palettes: {
      night: { gradient: ['#02040a', '#0a1220', '#1a2133'], ground: '#05070c', label: '#cfe0f7' },
      twilight: { gradient: ['#1b2340', '#4a3f63', '#b06a4a'], ground: '#0a0c12', label: '#ffd9a8' },
      day: { gradient: ['#3f74c9', '#7aa8e6', '#cfe0f5'], ground: '#28313a', label: '#10305c' },
    },
    camera: { yaw: 108, pitch: 6, fov, tracker: false, fovH: 10, fovV: 7, focal: 200 },
    ridge: Array.from({ length: 360 }, (_, i) => [i, 3, 0]),
    ridgeFar: Array.from({ length: 360 }, (_, i) => [i, 2, 0]),
    foregrounds: [],
    frames: [{ t: '07:37', d: '11-22', lst: 15.2, sun: -14, w: 1, tp: [], bodies: [], moon: null, comet: null, meteors: [] }],
  })
  const callsOf = (fov) => {
    const calls = []
    fn.skyRender(stubCtx(calls), { sim: make(fov), sky, free: false, camera: make(fov).camera, w: 960, h: 540 }, 0)
    return calls
  }
  for (const fov of [60, 120, 180]) {
    const calls = callsOf(fov)
    const wide = calls.filter((c) => c[0] === 'stroke' && c[3] > 12)
    assert.equal(wide.length, 0, `${fov}° 不应出现宽描边（会叠成竖条纹），实际 ${wide.length} 条`)
    assert.equal(calls.filter((c) => c[0] === 'stroke' && /206,217,242/.test(String(c[2]))).length, 0, `${fov}° 不再用描边画银河`)
    const fills = calls.filter((c) => c[0] === 'fill' && /rgba\(206,217,242/.test(String(c[3])))
    assert.ok(fills.length >= 1, `${fov}° 银河应仍然填充`)
  }
})

test('银河：极宽视场里不出现横穿画面的长弦（浅色带）', async () => {
  // 用真实银河等值线：逐环做近平面裁剪后，相邻顶点之间的边不应横穿画面
  const fn = renderer()
  const sky = skyview.skyMeta()
  const r = await search({ eventType: 'milkyway', location: '青海湖黑马河', dateStart: '2027-07-10', dateEnd: '2027-07-10', withSim: true, limit: 1 })
  assert.ok(r.ok && r.ranked[0].sim, r.message || '应有银河 sim')
  const sim = r.ranked[0].sim
  for (const fov of [120, 170]) {
    const fills = []
    let subs = []
    let cur = null
    const ctx = {
      createLinearGradient: () => ({ addColorStop() {} }),
      createRadialGradient: () => ({ addColorStop() {} }),
      fillRect() {}, strokeRect() {}, fillText() {}, beginPath() { subs = []; cur = null }, closePath() {},
      moveTo(x, y) { cur = [[x, y]]; subs.push(cur) },
      lineTo(x, y) { if (cur) cur.push([x, y]) },
      arc() {}, rect() {}, save() {}, restore() {}, clip() {}, setLineDash() {}, stroke() {},
      measureText: () => ({ width: 10 }),
      fill() { if (this.globalCompositeOperation === 'lighter') fills.push(subs.map((p) => p.slice())) },
      globalCompositeOperation: 'source-over',
      fillStyle: '#000',
    }
    fn.skyRender(ctx, { sim, sky, free: true, camera: { ...sim.camera, fov }, w: 960, h: 540 }, sim.startIndex)
    assert.ok(fills.length >= 1, `fov ${fov}: 银河应该画出来`)
    let worst = 0
    for (const poly of fills) {
      for (const path of poly) {
        for (let i = 0; i < path.length; i += 1) {
          const a = path[i]
          const b = path[(i + 1) % path.length]
          worst = Math.max(worst, Math.hypot(b[0] - a[0], b[1] - a[1]))
        }
      }
    }
    assert.ok(worst < 0.35 * 960, `fov ${fov}: 不应出现横穿画面的长边（最长 ${worst.toFixed(0)} px）`)
  }
})

test('默认画面：全部拍摄目标类型的目标都在画面正中', async () => {
  const fn = renderer()
  const CASES = [
    ['deepsky', { location: '海坨山', dateStart: '2027-03-10', dateEnd: '2027-03-10' }],
    ['milkyway', { location: '海坨山', dateStart: '2027-07-10', dateEnd: '2027-07-10' }],
    ['meteor', { location: '海坨山', dateStart: '2026-12-14', dateEnd: '2026-12-14' }],
    ['comet', { dateStart: '2028-05-20', dateEnd: '2028-06-10' }],
    ['planet', { location: '海坨山', dateStart: '2026-11-20', dateEnd: '2026-11-20' }],
    ['opposition', { dateStart: '2026-11-01', dateEnd: '2027-01-31' }],
    ['elongation', { dateStart: '2026-10-01', dateEnd: '2026-12-31' }],
    ['conjunction', { dateStart: '2026-11-01', dateEnd: '2026-11-30' }],
    ['solarEclipse', { dateStart: '2027-08-02', dateEnd: '2027-08-02' }],
    ['lunarEclipse', { dateStart: '2026-03-03', dateEnd: '2026-03-03' }],
    ['startrail', { location: '海坨山', dateStart: '2027-03-10', dateEnd: '2027-03-10' }],
    ['zodiacal', { location: '海坨山', dateStart: '2027-03-10', dateEnd: '2027-03-10' }],
  ]
  for (const [type, query] of CASES) {
    const r = await search({ eventType: type, withSim: true, limit: 1, ...query })
    assert.ok(r.ok, `${type} 检索失败：${r.message}`)
    const sim = r.ranked[0].sim
    const frame = sim.frames[sim.startIndex]
    assert.ok(frame && frame.tp.length, `${type} 默认帧应带目标`)
    // 目标（多目标取质心）经默认相机投影后应落在画面中心
    let x = 0, y = 0, z = 0
    for (const p of frame.tp) {
      const v = fn.skyVec(p[2], p[3])
      x += v[0]; y += v[1]; z += v[2]
    }
    const n = Math.hypot(x, y, z)
    const alt = Math.asin(Math.max(-1, Math.min(1, z / n))) / D2R
    const az = ((Math.atan2(x, y) / D2R) + 360) % 360
    const b = fn.skyBasis(sim.camera, 960, 540)
    const q = fn.skyProject(fn.skyVec(alt, az), b, 960, 540)
    assert.ok(q, `${type} 目标应可见`)
    const dx = Math.abs(q.x - 0.5) * 960
    const dy = Math.abs(q.y - 0.5) * 540
    // 相机 yaw/pitch 存成 0.1°，小视场下会有几像素的取整误差
    assert.ok(dx < 6 && dy < 6, `${type} 目标不在画面正中：偏移 ${dx.toFixed(1)}×${dy.toFixed(1)} px`)
  }
})

test('地景不再画三角形尖：山峰方向不额外加装饰', () => {
  const fn = renderer()
  const simOf = (kind) => ({
    version: 3, sky: 'night', lat: 40, lon: 116, targets: [], bodyNames: [],
    palettes: {
      night: { gradient: ['#02040a', '#0a1220', '#1a2133'], ground: '#05070c', label: '#cfe0f7' },
      twilight: { gradient: ['#1b2340', '#4a3f63', '#b06a4a'], ground: '#0a0c12', label: '#ffd9a8' },
      day: { gradient: ['#3f74c9', '#7aa8e6', '#cfe0f5'], ground: '#28313a', label: '#10305c' },
    },
    camera: { yaw: 0, pitch: 20, fov: 100, tracker: false, fovH: 10, fovV: 7, focal: 200 },
    ridge: Array.from({ length: 360 }, (_, i) => [i, 6, kind]),
    ridgeFar: Array.from({ length: 360 }, (_, i) => [i, 3, kind]),
    foregrounds: [],
    frames: [{ t: '22:00', d: '03-10', lst: 0, sun: -30, w: 1, tp: [], bodies: [], moon: null, comet: null, meteors: [] }],
  })
  const fillsOf = (kind) => {
    const calls = []
    const sim = simOf(kind)
    fn.skyRender(stubCtx(calls), { sim, sky: { stars: [], lines: [], ecliptic: [], milkyway: [] }, camera: sim.camera, w: 960, h: 540 }, 0)
    return calls.filter((c) => c[0] === 'fill').length
  }
  assert.equal(fillsOf(0), fillsOf(3), '山峰（0）与草甸（3）的填充次数应一致：山脊上不再叠加装饰')
  assert.ok(!skyview.RENDER_SRC.includes('三角形尖'), '渲染器里不应再有三角形尖的代码')
})

test('渲染器：太阳与月亮有文字标注', () => {
  const fn = renderer()
  const sim = {
    version: 3, sky: 'night', lat: 40, lon: 116, targets: [], bodyNames: ['水星', '金星', '火星', '木星', '土星', '太阳', '月球'],
    palette: { gradient: ['#02040a', '#050a12', '#0a1220'], ground: '#000', label: '#fff' },
    palettes: {
      night: { gradient: ['#02040a', '#050a12', '#0a1220'], ground: '#000', label: '#fff' },
      twilight: { gradient: ['#1b2340', '#4a3f63', '#b06a4a'], ground: '#000', label: '#ffd9a8' },
      day: { gradient: ['#3f74c9', '#7aa8e6', '#cfe0f5'], ground: '#111', label: '#012' },
    },
    camera: { yaw: 180, pitch: 30, fov: 60, tracker: false, fovH: 10, fovV: 7, focal: 200 },
    ridge: Array.from({ length: 360 }, (_, i) => [i, 1, 0]),
    ridgeFar: Array.from({ length: 360 }, (_, i) => [i, 0.5, 0]),
    foregrounds: [], startIndex: 0,
    frames: [{
      t: '22:00', d: '03-10', lst: 0, sun: -30, w: 1, tp: [], comet: null, meteors: [],
      // 月亮现在统一走 f.moon（只画一次），bodies 里只剩太阳
      moon: [0, -25, 60, 0.52],
      bodies: [[0, -15, 5, 0.53]],
    }],
  }
  const calls = []
  fn.skyRender(stubCtx(calls), { sim, sky: { stars: [], lines: [], ecliptic: [], milkyway: [] }, camera: sim.camera, w: 960, h: 540 }, 0)
  const texts = calls.filter((c) => c[0] === 'text').map((c) => c[1])
  assert.ok(texts.includes('太阳'), `应标注太阳：${texts.join('|')}`)
  assert.ok(texts.includes('月球'), `应标注月球：${texts.join('|')}`)
  assert.equal(texts.filter((t) => t === '月球').length, 1, '月球只标一次（不再重影）')
})

test('渲染器：月球按真实相位画（暗区面积与亮面朝向太阳）', () => {
  const fn = renderer()
  const R = (0.52 / 2) * ((551 / Math.tan(5 * D2R)) * 0.5 * D2R)
  const disc = Math.PI * R * R
  const run = (illum, sunAz) => {
    const sim = {
      version: 3, sky: 'night', lat: 40, lon: 116, targets: [], bodyNames: ['水星', '金星', '火星', '木星', '土星', '太阳', '月球'],
      palettes: {
        night: { gradient: ['#02040a', '#0a1220', '#1a2133'], ground: '#05070c', label: '#cfe0f7' },
        twilight: { gradient: ['#1b2340', '#4a3f63', '#b06a4a'], ground: '#0a0c12', label: '#ffd9a8' },
        day: { gradient: ['#3f74c9', '#7aa8e6', '#cfe0f5'], ground: '#28313a', label: '#10305c' },
      },
      camera: { yaw: 180, pitch: 45, fov: 20, tracker: false, fovH: 10, fovV: 7, focal: 200 },
      ridge: Array.from({ length: 360 }, (_, i) => [i, -2, 0]),
      ridgeFar: Array.from({ length: 360 }, (_, i) => [i, -3, 0]),
      foregrounds: [], startIndex: 0,
      frames: [{ t: '22:00', d: '03-10', lst: 0, sun: -20, w: 1, tp: [], bodies: [], comet: null, meteors: [],
        moon: [0, -5, illum, 0.52], sunAA: [-20, sunAz] }],
    }
    const paths = []
    let cur = null
    const ctx = {
      createLinearGradient: () => ({ addColorStop() {} }),
      createRadialGradient: () => ({ addColorStop() {} }),
      fillRect() {}, strokeRect() {}, fillText() {},
      beginPath() { cur = null }, closePath() {},
      moveTo(x, y) { cur = [[x, y]]; paths.push(cur) },
      lineTo(x, y) { if (cur) cur.push([x, y]) },
      arc() {}, rect() {}, save() {}, restore() {}, clip() {}, setLineDash() {}, stroke() {},
      measureText: () => ({ width: 10 }), fill() {}, fillStyle: '#000', globalCompositeOperation: 'source-over',
    }
    fn.skyRender(ctx, { sim, sky: { stars: [], lines: [], ecliptic: [], milkyway: [] }, camera: sim.camera, w: 960, h: 540 }, 0)
    let best = null
    for (const p of paths) {
      if (!p.length || p.some((q) => Math.hypot(q[0] - 480, q[1] - 270) > 2.5 * R)) continue
      let a = 0
      for (let i = 0; i < p.length; i += 1) { const q = p[i], r = p[(i + 1) % p.length]; a += q[0] * r[1] - r[0] * q[1] }
      a = Math.abs(a) / 2
      if (!best || a > best.a) best = { a, p }
    }
    let cx = 0, cy = 0
    if (best) { for (const q of best.p) { cx += q[0]; cy += q[1] } cx /= best.p.length; cy /= best.p.length }
    return { dark: best ? best.a / disc : 0, dir: best ? (Math.atan2(cy - 270, cx - 480) * R2D) : 0 }
  }
  // 满月没有暗区；亏凸/上下弦/娥眉的暗区面积分别 ≈ 25% / 50% / 75%
  assert.ok(run(100, 90).dark < 0.02, '满月不应有暗区')
  for (const [illum, want] of [[75, 0.25], [50, 0.5], [25, 0.75], [5, 0.95]]) {
    const got = run(illum, 90).dark
    assert.ok(Math.abs(got - want) < 0.05, `照明 ${illum}% 时暗区应 ≈${want}，实际 ${got.toFixed(2)}`)
  }
  // 太阳在东边 vs 西边：暗区应换到另一侧（相差接近 180°）
  const east = run(25, 90).dir
  const west = run(25, 270).dir
  const spread = Math.abs(((east - west + 540) % 360) - 180)
  assert.ok(Math.abs(180 - spread) < 45, `亮面应朝太阳：暗区方向 ${east.toFixed(0)}° vs ${west.toFixed(0)}°`)
})

test('渲染器：目标天体不会被重复标注（木星只标一次）', () => {
  const fn = renderer()
  const sim = {
    version: 3, sky: 'night', lat: 40, lon: 116, targets: [{ name: '木星', kind: 'planet', sizeDeg: 0.01 }],
    bodyNames: ['水星', '金星', '火星', '木星', '土星', '太阳', '月球'],
    palettes: {
      night: { gradient: ['#02040a', '#0a1220', '#1a2133'], ground: '#05070c', label: '#cfe0f7' },
      twilight: { gradient: ['#1b2340', '#4a3f63', '#b06a4a'], ground: '#0a0c12', label: '#ffd9a8' },
      day: { gradient: ['#3f74c9', '#7aa8e6', '#cfe0f5'], ground: '#28313a', label: '#10305c' },
    },
    camera: { yaw: 180, pitch: 40, fov: 40, tracker: false, fovH: 10, fovV: 7, focal: 200 },
    ridge: Array.from({ length: 360 }, (_, i) => [i, -2, 0]),
    ridgeFar: Array.from({ length: 360 }, (_, i) => [i, -3, 0]),
    foregrounds: [], startIndex: 0,
    frames: [{ t: '22:00', d: '03-10', lst: 0, sun: -30, w: 1, bodyNames: null,
      tp: [[0, -5, 40, 180]], bodies: [[0, -5, 3, 0.01]], moon: null, comet: null, meteors: [] }],
  }
  const calls = []
  fn.skyRender(stubCtx(calls), { sim, sky: { stars: [], lines: [], ecliptic: [], milkyway: [] }, camera: sim.camera, w: 960, h: 540 }, 0)
  const texts = calls.filter((c) => c[0] === 'text').map((c) => c[1])
  assert.equal(texts.filter((t) => t === '木星').length, 1, `木星只标一次：${texts.join('|')}`)
})

test('渲染器：合的取景框以两颗中点为心、且把两颗都框进去', () => {
  const fn = renderer()
  // 两颗相距 6°、左右分开；镜头视场只有 3°，框必须自己放大到装下两颗
  const sim = {
    version: 3, sky: 'night', lat: 40, lon: 116,
    targets: [{ name: '木星', kind: 'planet', sizeDeg: 0.02 }, { name: '火星', kind: 'planet', sizeDeg: 0.01 }],
    bodyNames: ['水星', '金星', '火星', '木星', '土星', '太阳', '月球'],
    palettes: {
      night: { gradient: ['#02040a', '#0a1220', '#1a2133'], ground: '#05070c', label: '#cfe0f7' },
      twilight: { gradient: ['#1b2340', '#4a3f63', '#b06a4a'], ground: '#0a0c12', label: '#ffd9a8' },
      day: { gradient: ['#3f74c9', '#7aa8e6', '#cfe0f5'], ground: '#28313a', label: '#10305c' },
    },
    camera: { yaw: 180, pitch: 45, fov: 18, tracker: false, fovH: 3, fovV: 2, focal: 400 },
    ridge: Array.from({ length: 360 }, (_, i) => [i, -2, 0]),
    ridgeFar: Array.from({ length: 360 }, (_, i) => [i, -3, 0]),
    foregrounds: [], startIndex: 0,
    frames: [{ t: '22:00', d: '03-10', lst: 0, sun: -30, w: 1, bodies: [], moon: null, comet: null, meteors: [],
      tp: [[0, -8, 42, 180], [0, -2, 48, 180]] }],
  }
  const calls = []
  const fnB = fn.skyBasis(sim.camera, 960, 540)
  fn.skyRender(stubCtx(calls), { sim, sky: { stars: [], lines: [], ecliptic: [], milkyway: [] }, camera: sim.camera, w: 960, h: 540 }, 0)
  const rect = calls.filter((c) => c[0] === 'strokeRect').pop()
  assert.ok(rect, '应画取景框')
  const [, rx, ry, rw, rh] = rect
  // 目标位置由赤经赤纬算出来（与渲染器同一条路径），两颗相距 6°
  const pts = sim.frames[0].tp.map((p) => {
    const aa = fn.skyEqToAltAz(p[0], p[1], 0, 40)
    const q = fn.skyProject(fn.skyVec(aa.alt, aa.az), fnB, 960, 540)
    assert.ok(q, '目标应可见')
    return { x: q.x * 960, y: q.y * 540 }
  })
  for (const p of pts) {
    assert.ok(p.x > rx && p.x < rx + rw && p.y > ry && p.y < ry + rh, `目标 (${p.x.toFixed(0)},${p.y.toFixed(0)}) 应落在取景框内`)
  }
  // 框心应该接近两颗的中点
  const midX = (pts[0].x + pts[1].x) / 2
  const midY = (pts[0].y + pts[1].y) / 2
  assert.ok(Math.abs(rx + rw / 2 - midX) < 2, `框心应压在两颗中点上：${(rx + rw / 2).toFixed(0)} vs ${midX.toFixed(0)}`)
  assert.ok(Math.abs(ry + rh / 2 - midY) < 2, `框心应压在两颗中点上：${(ry + rh / 2).toFixed(0)} vs ${midY.toFixed(0)}`)
})

test('银河：不同视场下填充区域不翻面（最浅层改描边后稳定）', () => {
  const fn = renderer()
  const sky = skyview.skyMeta()
  const simOf = (fov) => ({
    version: 3, sky: 'night', lat: 29.1, lon: 90.6, targets: [], bodyNames: [],
    palettes: {
      night: { gradient: ['#02040a', '#0a1220', '#1a2133'], ground: '#05070c', label: '#cfe0f7' },
      twilight: { gradient: ['#1b2340', '#4a3f63', '#b06a4a'], ground: '#0a0c12', label: '#ffd9a8' },
      day: { gradient: ['#3f74c9', '#7aa8e6', '#cfe0f5'], ground: '#28313a', label: '#10305c' },
    },
    camera: { yaw: 83, pitch: 19, fov, tracker: false, fovH: 10, fovV: 7, focal: 200 },
    ridge: Array.from({ length: 360 }, (_, i) => [i, -2, 0]),
    ridgeFar: Array.from({ length: 360 }, (_, i) => [i, -3, 0]),
    foregrounds: [],
    frames: [{ t: '21:04', d: '02-11', lst: 1.4, sun: -30, w: 1, tp: [], bodies: [], moon: null, comet: null, meteors: [] }],
  })
  const probe = (fov) => {
    const fills = []
    let subs = []
    let cur = null
    const ctx = {
      createLinearGradient: () => ({ addColorStop() {} }),
      createRadialGradient: () => ({ addColorStop() {} }),
      fillRect() {}, strokeRect() {}, fillText() {},
      beginPath() { subs = []; cur = null }, closePath() {},
      moveTo(x, y) { cur = [[x, y]]; subs.push(cur) },
      lineTo(x, y) { if (cur) cur.push([x, y]) },
      rect() {}, arc() {}, save() {}, restore() {}, clip() {}, setLineDash() {}, stroke() {},
      measureText: () => ({ width: 10 }),
      fill() { if (this.globalCompositeOperation === 'lighter') fills.push({ subs: subs.map((s) => s.slice()), style: this.fillStyle }) },
      globalCompositeOperation: 'source-over', fillStyle: '#000',
    }
    fn.skyRender(ctx, { sim: simOf(fov), sky, free: true, camera: simOf(fov).camera, w: 960, h: 540 }, 0)
    const cols = 40, rows = 14
    let cnt = 0
    let center = false
    for (let j = 0; j < rows; j += 1) for (let i = 0; i < cols; i += 1) {
      const px = (i + 0.5) / cols * 960, py = (j + 0.5) / rows * 540
      let hit = false
      for (const f of fills) {
        let par = false
        for (const ring of f.subs) for (let q = 0; q < ring.length; q += 1) {
          const a = ring[q], b = ring[(q + 1) % ring.length]
          if ((a[1] > py) !== (b[1] > py)) { const x = a[0] + ((py - a[1]) / (b[1] - a[1])) * (b[0] - a[0]); if (x > px) par = !par }
        }
        if (par) { hit = true; break }
      }
      if (hit) cnt += 1
      if (Math.abs(px - 480) < 12 && Math.abs(py - 270) < 12) center = hit
    }
    return { pct: cnt / (cols * rows) * 100, center }
  }
  const at = [18, 60, 120, 180].map((fov) => probe(fov))
  // 画面中心的填充状态必须一致（旧实现会在 150° 附近从 0% 翻到 86%）
  assert.equal(new Set(at.map((r) => r.center)).size, 1, `各视场中心状态应一致：${at.map((r) => r.center).join(',')}`)
  // 覆盖率随视场单调不减（放大 = 看到更少的天，不该忽多忽少），且不会整幅画面都算银河
  const pcts = at.map((r) => r.pct)
  for (let i = 1; i < pcts.length; i += 1) {
    assert.ok(pcts[i] >= pcts[i - 1] - 20, `覆盖不应随视场突然塌掉：${pcts.map((p) => p.toFixed(0) + '%').join('/')}`)
  }
  assert.ok(Math.max(...pcts) < 99, `不该整幅画面都算银河：${pcts.map((p) => p.toFixed(0) + '%').join('/')}`)
})

test('银河：五级都画、外宽内窄，且与球面真值逐点一致（不会和夜空互换）', async () => {
  const fn = renderer()
  const sky = skyview.skyMeta()
  const r = await search({ eventType: 'milkyway', location: '青海湖黑马河', dateStart: '2027-07-10', dateEnd: '2027-07-10', withSim: true, limit: 1 })
  assert.ok(r.ok && r.ranked[0].sim, r.message || '应有银河 sim')
  const sim = r.ranked[0].sim
  const k = sim.startIndex
  const f = sim.frames[k]
  // 屏幕点 → 天球方向（立体投影的逆）
  const dirOf = (B, W, H, px, py) => {
    const X = px - W / 2
    const Y = H / 2 - py
    const th = 2 * Math.atan(Math.hypot(X, Y) / B.k)
    const phi = Math.atan2(Y, X)
    const st = Math.sin(th)
    const ct = Math.cos(th)
    return [0, 1, 2].map((q) => ct * B.f[q] + st * (Math.cos(phi) * B.r[q] + Math.sin(phi) * B.u[q]))
  }
  // 球面绕数：方向 v 是否落在这组环围成的区域里（以 v 为极点建局部基，避开 RA 接缝）
  const winding = (rings, v) => {
    let e1 = Math.abs(v[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
    let t = [v[1] * e1[2] - v[2] * e1[1], v[2] * e1[0] - v[0] * e1[2], v[0] * e1[1] - v[1] * e1[0]]
    const tn = Math.hypot(t[0], t[1], t[2]) || 1
    e1 = [t[0] / tn, t[1] / tn, t[2] / tn]
    const e2 = [v[1] * e1[2] - v[2] * e1[1], v[2] * e1[0] - v[0] * e1[2], v[0] * e1[1] - v[1] * e1[0]]
    let sum = 0
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i += 1) {
        const a = ring[i]
        const b = ring[(i + 1) % ring.length]
        const ax = a[0] * e1[0] + a[1] * e1[1] + a[2] * e1[2]
        const ay = a[0] * e2[0] + a[1] * e2[1] + a[2] * e2[2]
        const bx = b[0] * e1[0] + b[1] * e1[1] + b[2] * e1[2]
        const by = b[0] * e2[0] + b[1] * e2[1] + b[2] * e2[2]
        sum += Math.atan2(ax * by - ay * bx, ax * bx + ay * by)
      }
    }
    return Math.abs(sum) > Math.PI
  }
  const screenParity = (subs, px, py) => {
    let par = false
    for (const ring of subs) {
      for (let i = 0; i < ring.length; i += 1) {
        const a = ring[i]
        const b = ring[(i + 1) % ring.length]
        if ((a[1] > py) !== (b[1] > py)) {
          const x = a[0] + ((py - a[1]) / (b[1] - a[1])) * (b[0] - a[0])
          if (x > px) par = !par
        }
      }
    }
    return par
  }
  const renderAt = (fov) => {
    const fills = []
    let subs = []
    let cur = null
    const ctx = {
      createLinearGradient: () => ({ addColorStop() {} }),
      createRadialGradient: () => ({ addColorStop() {} }),
      fillRect() {}, strokeRect() {}, fillText() {},
      beginPath() { subs = []; cur = null }, closePath() {},
      moveTo(x, y) { cur = [[x, y]]; subs.push(cur) },
      lineTo(x, y) { if (cur) cur.push([x, y]) },
      arc() {}, rect() {}, save() {}, restore() {}, clip() {}, setLineDash() {}, stroke() {},
      measureText: () => ({ width: 10 }),
      fill() {
        if (this.globalCompositeOperation !== 'lighter') return
        const m = /rgba\(206,217,242,([\d.]+)\)/.exec(String(this.fillStyle))
        if (m) fills.push({ alpha: Number(m[1]), subs: subs.map((s) => s.slice()) })
      },
      globalCompositeOperation: 'source-over', fillStyle: '#000',
    }
    fn.skyRender(ctx, { sim, sky, free: false, camera: { ...sim.camera, fov }, w: 960, h: 540 }, k)
    return fills
  }
  const area = (subs) => {
    let a = 0
    for (const ring of subs) {
      for (let i = 0; i < ring.length; i += 1) {
        const p = ring[i]
        const q = ring[(i + 1) % ring.length]
        a += p[0] * q[1] - q[0] * p[1]
      }
    }
    return Math.abs(a) / 2
  }
  for (const fov of [60, 120, 180]) {
    const fills = renderAt(fov)
    assert.equal(fills.length, 5, `fov ${fov}: 五级环带各一笔，实际 ${fills.length}`)
    assert.deepEqual(fills.map((x) => x.alpha), [0.01, 0.06, 0.05, 0.05, 0.05], `fov ${fov}: alpha 序列变了`)
    const areas = fills.map((x) => area(x.subs))
    assert.ok(areas[0] > 0, `fov ${fov}: 最外圈薄雾必须画出来`)
    assert.ok(areas[4] > 0, `fov ${fov}: 最内圈也必须画出来`)
    for (const x of fills) assert.ok(x.alpha > 0 && x.alpha <= 0.13, `alpha 越界：${x.alpha}`)
  }
  // 与球面真值逐点对拍：每级「屏幕奇偶」必须等于「球面绕数」
  const B = fn.skyBasis({ yaw: sim.camera.yaw, pitch: sim.camera.pitch, fov: 120 }, 960, 540)
  const fills120 = renderAt(120)
  const ringSets = [0, 1, 2, 3, 4].map((lv) => {
    const data = sky.milkyway.filter((m) => m.level === lv)[0]
    const out = []
    for (const polys of data.polys) for (const ring of polys) {
      out.push(ring.map(([ra, dec]) => {
        const aa = fn.skyEqToAltAz(ra, dec, f.lst, sim.lat)
        return fn.skyVec(aa.alt, aa.az)
      }))
    }
    return out
  })
  const cols = 24
  const rows = 14
  let mismatch = 0
  let total = 0
  for (let j = 0; j < rows; j += 1) for (let i = 0; i < cols; i += 1) {
    const px = ((i + 0.5) / cols) * 960
    const py = ((j + 0.5) / rows) * 540
    const v = dirOf(B, 960, 540, px, py)
    for (const li of [1, 2, 3, 4]) {
      const want = winding(ringSets[li], v)
      const got = screenParity(fills120[li].subs, px, py)
      total += 1
      if (want !== got) mismatch += 1
    }
  }
  assert.ok(mismatch / total < 0.02, `屏幕填充与球面真值不一致 ${mismatch}/${total} 点（>2% 就是错位/翻面）`)
})

test('银河：播放换帧时层间 alpha 不互换', async () => {
  const fn = renderer()
  const sky = skyview.skyMeta()
  const r = await search({ eventType: 'milkyway', location: '青海湖黑马河', dateStart: '2027-07-10', dateEnd: '2027-07-10', withSim: true, limit: 1 })
  const sim = r.ranked[0].sim
  const renderAt = (k) => {
    const fills = []
    let subs = []
    let cur = null
    const ctx = {
      createLinearGradient: () => ({ addColorStop() {} }),
      createRadialGradient: () => ({ addColorStop() {} }),
      fillRect() {}, strokeRect() {}, fillText() {},
      beginPath() { subs = []; cur = null }, closePath() {},
      moveTo(x, y) { cur = [[x, y]]; subs.push(cur) },
      lineTo(x, y) { if (cur) cur.push([x, y]) },
      arc() {}, rect() {}, save() {}, restore() {}, clip() {}, setLineDash() {}, stroke() {},
      measureText: () => ({ width: 10 }),
      fill() {
        const m = /rgba\(206,217,242,([\d.]+)\)/.exec(String(this.fillStyle))
        if (m && this.globalCompositeOperation === 'lighter') fills.push(Number(m[1]))
      },
      globalCompositeOperation: 'source-over', fillStyle: '#000',
    }
    fn.skyRender(ctx, { sim, sky, free: false, camera: sim.camera, w: 960, h: 540 }, k)
    return fills
  }
  for (let k = sim.startIndex; k < Math.min(sim.frames.length, sim.startIndex + 3); k += 1) {
    const fills = renderAt(k)
    assert.equal(fills.length, 5, `第 ${k} 帧应画五级环带`)
    assert.deepEqual(fills, [0.01, 0.06, 0.05, 0.05, 0.05], `第 ${k} 帧层序/alpha 变了：${fills.join(',')}`)
  }
})

test('合：初始帧回到最佳时段开始，两颗仍在画面里', async () => {
  const fn = renderer()
  const sky = skyview.skyMeta()
  const r = await search({ eventType: 'conjunction', dateStart: '2026-11-01', dateEnd: '2026-11-30', withSim: true, limit: 12 })
  assert.ok(r.ok, r.message)
  const rows = r.ranked.filter((x) => x.sim && x.sim.frames && x.sim.frames.length)
  assert.ok(rows.length, '应有合的 sim')
  for (const x of rows) {
    const sim = x.sim
    const first = sim.frames.findIndex((f) => f.w === 1)
    assert.equal(sim.startIndex, first, `${x.target.name}: 初始帧应是最佳时段开始（w=1 的第一帧）`)
    const f = sim.frames[sim.startIndex]
    if (!f.tp || f.tp.length < 2) continue
    const spread = skyview.tpSpreadDeg(f.tp)
    assert.ok(sim.camera.fov >= Math.min(90, spread * 2) - 0.01, `${x.target.name}: 视场 ${sim.camera.fov}° 应装得下角距 ${spread.toFixed(1)}°`)
    // 两颗都落在取景框里
    const calls = []
    fn.skyRender(stubCtx(calls), { sim, sky, free: false, camera: sim.camera, w: 960, h: 540 }, sim.startIndex)
    const rect = calls.filter((c) => c[0] === 'strokeRect').pop()
    assert.ok(rect, `${x.target.name}: 应有取景框`)
    const B = fn.skyBasis(sim.camera, 960, 540)
    const pts = f.tp.map((p) => {
      const aa = fn.skyEqToAltAz(p[0], p[1], f.lst, sim.lat)
      return fn.skyProject(fn.skyVec(aa.alt, aa.az), B, 960, 540)
    })
    if (pts.some((q) => !q)) continue
    for (const q of pts) {
      const px = q.x * 960
      const py = q.y * 540
      assert.ok(px > rect[1] - 1 && px < rect[1] + rect[3] + 1 && py > rect[2] - 1 && py < rect[2] + rect[4] + 1,
        `${x.target.name}: 目标 (${px.toFixed(0)},${py.toFixed(0)}) 应落在取景框内`)
    }
  }
})

test('渲染器：银河 / 黄道光目标不再画取景框中央的光晕', () => {
  const fn = renderer()
  const base = (kind) => ({
    version: 3, sky: 'night', lat: 40, lon: 116,
    targets: [{ name: kind === 'milkyway' ? '银河' : '黄道光', kind, sizeDeg: 20 }],
    bodyNames: [],
    palettes: {
      night: { gradient: ['#02040a', '#0a1220', '#1a2133'], ground: '#05070c', label: '#cfe0f7' },
      twilight: { gradient: ['#1b2340', '#4a3f63', '#b06a4a'], ground: '#0a0c12', label: '#ffd9a8' },
      day: { gradient: ['#3f74c9', '#7aa8e6', '#cfe0f5'], ground: '#28313a', label: '#10305c' },
    },
    camera: { yaw: 180, pitch: 40, fov: 60, tracker: false, fovH: 40, fovV: 27, focal: 50 },
    ridge: Array.from({ length: 360 }, (_, i) => [i, -2, 0]),
    ridgeFar: Array.from({ length: 360 }, (_, i) => [i, -3, 0]),
    foregrounds: [], startIndex: 0,
    frames: [{ t: '22:00', d: '03-10', lst: 0, sun: -30, w: 1, bodies: [], moon: null, comet: null, meteors: [], tp: [[0, -5, 40, 180]] }],
  })
  const probe = (kind) => {
    const calls = []
    const sim = base(kind)
    fn.skyRender(stubCtx(calls), { sim, sky: { stars: [], lines: [], ecliptic: [], milkyway: [] }, camera: sim.camera, w: 960, h: 540 }, 0)
    return calls
  }
  for (const kind of ['milkyway', 'glow']) {
    const calls = probe(kind)
    // 目标位置不应有径向渐变填充（那是「取景框中间一团光晕」）：填充色是渐变对象而不是字符串
    const grabs = calls.filter((c) => c[0] === 'fill' && typeof c[3] === 'object')
    assert.equal(grabs.length, 0, `${kind} 目标不该画中心光晕，实际 ${grabs.length} 处`)
    // 取景框与名字还在
    assert.ok(calls.some((c) => c[0] === 'strokeRect'), `${kind} 仍要有取景框`)
    assert.ok(calls.filter((c) => c[0] === 'text').some((c) => /银河|黄道光/.test(String(c[1]))), `${kind} 仍要有名字`)
  }
  // 深空目标仍保留柔光标记（回归）
  const deep = probe('deepsky')
  assert.ok(deep.some((c) => c[0] === 'fill' && typeof c[3] === 'object'), '深空目标仍应有柔光标记')
})

test('渲染器：晨昏时暖亮的一侧朝着太阳', () => {
  const fn = renderer()
  const simOf = (sunAlt) => ({
    version: 3, sky: sunAlt > -18 ? 'twilight' : 'night', lat: 40, lon: 116, targets: [], bodyNames: [],
    palettes: {
      night: { gradient: ['#02040a', '#0a1220', '#1a2133'], ground: '#05070c', label: '#cfe0f7' },
      twilight: { gradient: ['#1b2340', '#4a3f63', '#b06a4a'], ground: '#0a0c12', label: '#ffd9a8' },
      day: { gradient: ['#3f74c9', '#7aa8e6', '#cfe0f5'], ground: '#28313a', label: '#10305c' },
    },
    camera: { yaw: 90, pitch: 12, fov: 80, tracker: false, fovH: 40, fovV: 27, focal: 50 },
    ridge: Array.from({ length: 360 }, (_, i) => [i, -2, 0]),
    ridgeFar: Array.from({ length: 360 }, (_, i) => [i, -3, 0]),
    foregrounds: [], startIndex: 0,
    frames: [{ t: '06:10', d: '03-10', lst: 0, sun: sunAlt, w: 1, tp: [], bodies: [], moon: null, comet: null, meteors: [],
      sunAA: [sunAlt, 90] }],
  })
  const strips = (sunAlt) => {
    const out = []
    const grads = []
    const ctx = {
      createLinearGradient: () => {
        const g = { stops: [], addColorStop(t, c) { this.stops.push(c) } }
        grads.push(g)
        return g
      },
      createRadialGradient: () => ({ addColorStop() {} }),
      fillRect(x, y, w, h) {
        const g = grads[grads.length - 1]
        // 只收「天空底色」那些竖向渐变（≥5 个色标）；地面压暗只有 2 个
        if (h >= 540 - 1 && g && g.stops.length >= 5) out.push({ x, w, grad: g })
      },
      strokeRect() {}, fillText() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
      arc() {}, rect() {}, save() {}, restore() {}, clip() {}, setLineDash() {}, stroke() {}, fill() {},
      measureText: () => ({ width: 10 }),
      fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, composite: 'source-over', globalCompositeOperation: 'source-over',
    }
    fn.skyRender(ctx, { sim: simOf(sunAlt), sky: { stars: [], lines: [], ecliptic: [], milkyway: [] }, camera: simOf(sunAlt).camera, w: 960, h: 540 }, 0)
    return out
  }
  const lum = (hex) => {
    const v = parseInt(String(hex).slice(1), 16)
    return ((v >> 16) & 255) * 0.3 + ((v >> 8) & 255) * 0.59 + (v & 255) * 0.11
  }
  const twi = strips(-8)
  assert.ok(twi.length >= 32, `晨昏应分条绘制（>32 条），实际 ${twi.length}`)
  // 相机朝东、太阳在正东：画面中央那一条是朝阳侧，最左/最右是背阳侧
  const mid = twi.find((s) => Math.abs(s.x + s.w / 2 - 480) < 20) || twi[Math.floor(twi.length / 2)]
  const edge = twi[0]
  const midHorizon = mid.grad.stops[mid.grad.stops.length - 1]
  const edgeHorizon = edge.grad.stops[edge.grad.stops.length - 1]
  assert.ok(lum(midHorizon) > lum(edgeHorizon) + 3, `朝阳侧应更亮：${midHorizon} vs ${edgeHorizon}`)
  assert.ok(parseInt(midHorizon.slice(1, 3), 16) > parseInt(edgeHorizon.slice(1, 3), 16), `朝阳侧应更暖：${midHorizon} vs ${edgeHorizon}`)
  // 夜里不参与分条，仍是一条竖向渐变
  const night = strips(-25)
  assert.equal(night.length, 1, `夜间天空应只有一条渐变，实际 ${night.length}`)
})

test('渲染器：合月里月球显示相位，不再被目标标记盖成白盘', async () => {
  const fn = renderer()
  const sky = skyview.skyMeta()
  const r = await search({ eventType: 'conjunction', dateStart: '2026-11-01', dateEnd: '2026-11-30', withSim: true, limit: 20 })
  assert.ok(r.ok, r.message)
  const rows = r.ranked.filter((x) => x.sim && (x.sim.targets || []).some((t) => t.kind === 'moon'))
  assert.ok(rows.length, '应找到月球参与成像的合月行')
  // 合的初始帧是「最佳时段开始」，那一刻月球未必已经升起：往后找一帧月球真的在地平线以上的
  let sim = null
  let f = null
  let frameIdx = -1
  let cam = null
  let q = null
  let B = null
  for (const row of rows) {
    const sd = row.sim
    for (let k = sd.startIndex; k < sd.frames.length; k += 1) {
      const fr = sd.frames[k]
      if (!fr.moon) continue
      const aa = fn.skyEqToAltAz(fr.moon[0], fr.moon[1], fr.lst, sd.lat)
      if (aa.alt < 5) continue
      const c2 = { yaw: aa.az, pitch: Math.max(0, aa.alt), fov: 8, tracker: false, fovH: 10, fovV: 7, focal: 200 }
      const b2 = fn.skyBasis(c2, 960, 540)
      const p2 = fn.skyProject(fn.skyVec(aa.alt, aa.az), b2, 960, 540)
      if (!p2) continue
      sim = sd; f = fr; frameIdx = k; cam = c2; q = p2; B = b2
      break
    }
    if (sim) break
  }
  assert.ok(sim, '应有一帧月球在地平线以上')
  const mAA = fn.skyEqToAltAz(f.moon[0], f.moon[1], f.lst, sim.lat)
  const mx = q.x * 960
  const my = q.y * 540
  const R = (f.moon[3] / 2) * B.k * 0.5 * D2R
  const ops = []
  let cur = null
  const ctx = {
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    fillRect() {}, strokeRect() {}, fillText() {},
    beginPath() { cur = null }, closePath() {},
    moveTo(x2, y2) { cur = { pts: [[x2, y2]] }; ops.push(cur) },
    lineTo(x2, y2) { if (cur && cur.pts) cur.pts.push([x2, y2]) },
    arc(x2, y2, rad) { cur = { arc: [x2, y2, rad] }; ops.push(cur) },
    rect() {}, save() {}, restore() {}, clip() {}, setLineDash() {},
    stroke() { if (cur) { cur.drawn = 'stroke'; cur.style = String(ctx.strokeStyle) } },
    fill() { if (cur) { cur.drawn = 'fill'; cur.style = String(ctx.fillStyle) } },
    measureText: () => ({ width: 10 }),
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1, globalCompositeOperation: 'source-over',
  }
  fn.skyRender(ctx, { sim, sky, free: true, camera: cam, w: 960, h: 540 }, frameIdx)
  const near = ops.filter((o) => (o.arc ? Math.hypot(o.arc[0] - mx, o.arc[1] - my) < 3 * R
    : o.pts.every((p) => Math.hypot(p[0] - mx, p[1] - my) < 3 * R)))
  // 1) 目标标记不能再画实心白盘（旧实现 r≈R 的白色 fill 会把相位整个盖掉）
  const whiteDisc = near.filter((o) => o.drawn === 'fill' && o.arc && o.arc[2] > 4
    && /rgba\(255,\s*255,\s*255/.test(o.style))
  assert.equal(whiteDisc.length, 0, `月球位置上不应再有实心白盘：${whiteDisc.map((o) => o.arc[2].toFixed(0)).join(',')}`)
  // 2) 应有一圈定位环
  const ring = near.filter((o) => o.drawn === 'stroke' && /rgba\(255,255,255,\.5\)/.test(o.style))
  assert.equal(ring.length, 1, `月球应只有一圈定位环，实际 ${ring.length}`)
  // 3) 相位仍在：暗区面积 ≈ 1 − 照明比例
  const disc = Math.PI * R * R
  let darkArea = 0
  for (const o of near) {
    if (o.drawn !== 'fill' || !o.pts || o.pts.length < 8) continue
    let a = 0
    for (let i = 0; i < o.pts.length; i += 1) {
      const p = o.pts[i]
      const n = o.pts[(i + 1) % o.pts.length]
      a += p[0] * n[1] - n[0] * p[1]
    }
    darkArea = Math.max(darkArea, Math.abs(a) / 2)
  }
  const darkPct = (darkArea / disc) * 100
  const want = 100 - f.moon[2]
  assert.ok(Math.abs(darkPct - want) < 8, `暗区应 ≈ ${want.toFixed(0)}%，实际 ${darkPct.toFixed(0)}%`)
})

test('渲染器：月食时月球压暗偏红（全食不再是亮白满月）', async () => {
  const fn = renderer()
  const sky = skyview.skyMeta()
  const r = await search({ eventType: 'lunarEclipse', dateStart: '2026-03-01', dateEnd: '2026-03-05', withSim: true, limit: 5 })
  assert.ok(r.ok, r.message)
  const row = r.ranked.find((x) => x.sim && x.sim.frames[x.sim.startIndex].moon && x.sim.frames[x.sim.startIndex].moonObsc > 0.5)
  assert.ok(row, '应找到食分 > 0.5 的月食行')
  const sim = row.sim
  const f = sim.frames[sim.startIndex]
  const mAA = fn.skyEqToAltAz(f.moon[0], f.moon[1], f.lst, sim.lat)
  const cam = { yaw: mAA.az, pitch: Math.max(0, mAA.alt), fov: 8, tracker: false, fovH: 10, fovV: 7, focal: 200 }
  const B = fn.skyBasis(cam, 960, 540)
  const q = fn.skyProject(fn.skyVec(mAA.alt, mAA.az), B, 960, 540)
  const fills = []
  let cur = null
  let alpha = 1
  const ctx = {
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    fillRect() {}, strokeRect() {}, fillText() {},
    beginPath() { cur = null }, closePath() {},
    moveTo() {}, lineTo() {},
    arc(x2, y2, rad) { cur = { arc: [x2, y2, rad] } },
    rect() {}, save() {}, restore() {}, clip() {}, setLineDash() {}, stroke() {},
    fill() { if (cur && cur.arc) fills.push({ a: cur.arc, style: String(ctx.fillStyle), alpha: ctx.globalAlpha }) },
    measureText: () => ({ width: 10 }),
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1, globalCompositeOperation: 'source-over',
  }
  fn.skyRender(ctx, { sim, sky, free: true, camera: cam, w: 960, h: 540 }, sim.startIndex)
  const moonFill = fills.filter((o) => Math.hypot(o.a[0] - q.x * 960, o.a[1] - q.y * 540) < 20 && o.a[2] > 4)
  assert.ok(moonFill.length, '月球本体应有填充')
  const lit = moonFill[0]
  assert.ok(lit.alpha < 0.9, `月食时亮面应压暗，alpha=${lit.alpha}`)
  const hex = /#([0-9a-f]{6})/i.exec(lit.style)
  assert.ok(hex, `月食时亮面应带颜色，实际 ${lit.style}`)
  const v = parseInt(hex[1], 16)
  const rr = (v >> 16) & 255
  const bb = v & 255
  assert.ok(rr - bb > 20, `月食月球应偏红：R=${rr} B=${bb}（${lit.style}）`)
})

test('日月食：用站点实际可见的标签（全食/偏食）', async () => {
  const r = await search({ eventType: 'lunarEclipse', dateStart: '2026-03-03', dateEnd: '2026-03-03', withSim: true, limit: 3 })
  assert.ok(r.ok, r.message)
  const row = r.ranked[0]
  assert.match(row.target.name, /月全食|月偏食|半影月食/, `行标签 ${row.target.name}`)
  assert.equal(row.sim.targets[0].name, row.target.name, '画面模拟用同一份 per-site 标签')
})
