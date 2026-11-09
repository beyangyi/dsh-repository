import assert from 'node:assert/strict'
import test from 'node:test'

import * as astro from '../lib/astro.js'
import * as catalog from '../lib/catalog.js'
import { conjunctionSetup, fieldOfView, meta, parseOptions, search, timeline } from '../lib/planner.js'
import { scoreNight } from '../lib/weather.js'

// 用远期日期跑「纯天文」路径，避免测试依赖网络
const FAR = { dateStart: '2027-03-10', dateEnd: '2027-03-11' }

test('检索：类型过滤生效', async () => {
  // 2027-08-12 是英仙座极大夜（ZHR 100），落在 ±7 天窗口内
  const r = await search({ eventType: 'meteor', dateStart: '2027-08-12', dateEnd: '2027-08-12', siteLimit: 12, limit: 5 })
  assert.ok(r.ok, r.message)
  assert.ok(r.ranked.length > 0)
  assert.ok(r.ranked.every((x) => x.target.type === 'meteor'))
})

test('流星雨：只在极大值 ±7 天内、且 ZHR ≥ 10 才出现', async () => {
  const peak = await search({ eventType: 'meteor', dateStart: '2027-08-12', dateEnd: '2027-08-12', siteLimit: 8, pageSize: 5 })
  assert.ok(peak.ok, peak.message)
  assert.ok(peak.ranked.every((x) => /英仙座/.test(x.target.name)))

  const within = await search({ eventType: 'meteor', dateStart: '2027-08-17', dateEnd: '2027-08-17', siteLimit: 8, pageSize: 5 })
  assert.ok(within.ok, within.message)
  assert.ok(within.ranked.every((x) => /英仙座/.test(x.target.name)))

  const outside = await search({ eventType: 'meteor', dateStart: '2027-08-22', dateEnd: '2027-08-22', siteLimit: 8, pageSize: 5 })
  assert.equal(outside.ok, false)
  assert.equal(outside.error, 'no_visible')
  assert.match(outside.message, /±7 天/)

  // 北金牛 ZHR 只有 5 → 即使在极大夜也不出现（同夜的狮子座 ZHR 15 可以出现）
  const weak = await search({ eventType: 'meteor', dateStart: '2026-11-12', dateEnd: '2026-11-13', siteLimit: 8, pageSize: 5 })
  assert.ok(weak.ok, weak.message)
  assert.ok(weak.ranked.every((x) => !/金牛座/.test(x.target.name)), 'ZHR 5 的金牛座不应出现')
})

test('流星雨：峰值按年份平移，跨年仍可用', async () => {
  const r = await search({ eventType: 'meteor', dateStart: '2028-12-14', dateEnd: '2028-12-14', siteLimit: 6, pageSize: 3 })
  assert.ok(r.ok, r.message)
  assert.match(r.ranked[0].target.name, /双子座/)
})

test('检索：远期日期不取天气，标注 out_of_range', async () => {
  const r = await search({ eventType: 'deepsky', ...FAR, siteLimit: 8, limit: 4 })
  assert.ok(r.ok)
  for (const x of r.ranked) {
    assert.equal(x.weather.status, 'out_of_range')
    assert.equal(x.breakdown.weather, null)
  }
  assert.ok(r.notes.some((n) => n.includes('天气')))
})

test('检索：站点 Bortle 过滤生效', async () => {
  const r = await search({ eventType: 'deepsky', ...FAR, maxBortle: 2, siteLimit: 20, limit: 6 })
  assert.ok(r.ok)
  assert.ok(r.ranked.every((x) => x.site.bortle <= 2))
})

test('检索：地点解析到单站', async () => {
  const r = await search({ eventType: 'deepsky', location: '海坨山', ...FAR, limit: 4 })
  assert.ok(r.ok)
  assert.ok(r.ranked.every((x) => x.site.id === 'haituo'))
})

test('检索：结果多样性与排序单调性', async () => {
  const r = await search({ eventType: 'deepsky', ...FAR, siteLimit: 12, limit: 8 })
  assert.ok(r.ok)
  const scores = r.ranked.map((x) => x.score)
  const sorted = [...scores].sort((a, b) => b - a)
  assert.deepEqual(scores, sorted, '结果必须按推荐度降序')
  // 指定类型时不再做目标配额，但「同一站同一目标」只能出现一次（保证地点多样）
  const pairs = new Set(r.ranked.map((x) => `${x.target.id}|${x.site.id}`))
  assert.equal(pairs.size, r.ranked.length, '同一站同一目标不应重复出现')
})

test('流星雨：多夜查询要给出多个站点，而不是同一站重复', async () => {
  const r = await search({ eventType: 'meteor', dateStart: '2026-12-14', dateEnd: '2026-12-16', pageSize: 20 })
  assert.ok(r.ok, r.message)
  const sites = new Set(r.ranked.map((x) => x.site.id))
  assert.ok(sites.size >= 10, `应推荐多个站点，实际 ${sites.size} 个`)
  const pairs = r.ranked.map((x) => `${x.target.id}|${x.site.id}`)
  assert.equal(new Set(pairs).size, pairs.length, '同一站同一流星雨只保留一条')
})

test('画面模拟：withSim 开关控制数据是否附带', async () => {
  const on = await search({ eventType: 'deepsky', location: '海坨山', ...FAR, limit: 1, withSim: true })
  assert.ok(on.ok, on.message)
  const sim = on.ranked[0].sim
  assert.ok(sim, '开启 withSim 时应有画面模拟数据')
  assert.equal(sim.version, 3)
  assert.equal(sim.skip, null)
  assert.ok(sim.frames.length >= 5 && sim.frames.length <= 73, `帧数 ${sim.frames.length}`)
  assert.ok(sim.ridge.length > 10, '应带地形剪影折线')
  assert.ok(sim.frames.every((f) => f.tp.length >= 1 && f.lst >= 0 && f.lst < 24), '每帧都要有恒星时与目标')
  assert.ok(sim.targets.length >= 1 && sim.foregrounds.length >= 1)
  assert.ok(sim.camera && sim.camera.fovH > 0 && sim.camera.fov > 0)
  assert.match(sim.caption, /\d+mm/)

  const off = await search({ eventType: 'deepsky', location: '海坨山', ...FAR, limit: 1 })
  assert.equal(off.ranked[0].sim, null, '默认不算画面模拟（工具结果保持精简）')
})

test('检索：不可见条件返回可读错误', async () => {
  const r = await search({ eventType: 'zodiacal', location: '澳门', ...FAR, minAltitude: 75, limit: 3 })
  assert.equal(r.ok, false)
  assert.ok(['no_visible', 'no_target'].includes(r.error))
})

test('参数：深空一律按赤道仪参数计算', async () => {
  // 深空长焦、暗弱：无论用户是否勾选赤道仪，都按 120s 单张 + 20 张叠加给参数
  const a = await search({ eventType: 'deepsky', location: '海坨山', ...FAR, format: 'ff', tracker: false, limit: 3 })
  const b = await search({ eventType: 'deepsky', location: '海坨山', ...FAR, format: 'aps-c', tracker: true, limit: 3 })
  for (const r of [a, b]) {
    assert.ok(r.ok, r.message)
    const p = r.ranked[0].params
    assert.equal(p.exposureSec, 120, '深空单张按赤道仪 120s 计')
    assert.equal(p.frames, 20, '深空按赤道仪 20 张叠加')
    assert.equal(p.trackerNeeded, true, '深空应标识需要赤道仪')
    assert.equal(p.trackerRequired, true, '深空没有无赤道仪方案')
    assert.equal(p.rule, 'tracker')
    assert.match(p.note, /赤道仪/)
  }
  assert.notEqual(a.ranked[0].params.apsFocal, a.ranked[0].params.ffFocal)
})

test('参数：无赤道仪时广角按 500 法则、长焦按 300 法则算曝光', async () => {
  const mid = (lo, hi) => Math.round((lo + hi) / 2)
  const expectLimit = (lo, hi, crop = 1) => {
    const limit = mid(lo, hi) <= 35 ? 500 : 300
    const eff = Math.round(mid(lo, hi) * crop * 10) / 10
    return { limit, eff, sec: Math.max(0.5, Math.round((limit / eff) * 10) / 10) }
  }

  const cases = [
    ['milkyway', '2027-07-10', 14, 24],
    ['meteor', '2026-12-14', 14, 20],
    ['startrail', '2027-07-10', 16, 35],
  ]
  for (const [eventType, date, fMin, fMax] of cases) {
    const r = await search({ eventType, location: '海坨山', dateStart: date, dateEnd: date, format: 'ff', limit: 1 })
    assert.ok(r.ok, `${eventType}: ${r.message}`)
    const p = r.ranked[0].params
    const want = expectLimit(fMin, fMax)
    assert.equal(want.limit, 500, '这三个都是广角')
    assert.equal(p.rule, '500', `${eventType} 应走 500 法则`)
    assert.equal(p.untrackedLimit, 500)
    assert.equal(p.effectiveFocal, want.eff, `${eventType} 等效焦距`)
    assert.equal(p.exposureSec, want.sec, `${eventType} 代表值 = 法则值 ÷ 等效焦距`)
    assert.equal(p.trackerNeeded, false)
    // 便签不再解释法则，曝光直接写成区间（长焦端短、广角端长）
    assert.equal(p.hint, '', '不再给法则说明')
    assert.match(p.exposureText, /^\d+(\.\d+)?–\d+(\.\d+)? s( × \d+ 张)?$/, `${eventType} 曝光应写成 a–b s`)
    assert.equal(p.exposureRange.min, Math.max(0.5, Math.round((500 / fMax) * 10) / 10))
    assert.equal(p.exposureRange.max, Math.max(0.5, Math.round((500 / fMin) * 10) / 10))
    assert.ok(p.exposureRange.min < p.exposureRange.max, '两端焦距不同 → 区间有跨度')
    assert.ok(p.exposureSec >= p.exposureRange.min && p.exposureSec <= p.exposureRange.max)
  }

  // APS-C：等效焦距 ×1.5 → 安全曝光必须更短
  const apsc = await search({ eventType: 'milkyway', location: '海坨山', dateStart: '2027-07-10', dateEnd: '2027-07-10', format: 'aps-c', limit: 1 })
  const ff = expectLimit(14, 24)
  const crop = expectLimit(14, 24, 1.5)
  assert.equal(apsc.ranked[0].params.effectiveFocal, crop.eff)
  assert.equal(apsc.ranked[0].params.exposureSec, crop.sec)
  assert.ok(apsc.ranked[0].params.exposureSec < ff.sec, 'APS-C 裁切换算后曝光更短')
  assert.ok(apsc.ranked[0].params.exposureRange.max < ff.sec, 'APS-C 区间上限也应更短')

  // 长焦（彗星 85–400mm，中位 243mm）回到 300 法则：比 500 法则更短
  const comet = await search({ eventType: 'comet', dateStart: '2028-05-20', dateEnd: '2028-06-10', limit: 1 })
  assert.ok(comet.ok, comet.message)
  const cp = comet.ranked[0].params
  assert.equal(cp.rule, '300', '长焦走 300 法则')
  assert.equal(cp.untrackedLimit, 300, '长焦应回到 300 法则')
  const cometMid = cp.ffFocalMid
  assert.equal(cp.exposureSec, Math.max(0.5, Math.round((300 / cometMid) * 10) / 10))
  assert.ok(cp.exposureSec < Math.round((500 / cometMid) * 10) / 10, '长焦不该再用 500 法则')
  assert.match(cp.exposureText, /^\d+(\.\d+)?–\d+(\.\d+)? s × \d+ 张$/, '彗星曝光是区间 + 张数')
})

test('参数：单个行星 / 冲日 / 大距 只给赤道仪参数', async () => {
  const cases = [
    ['planet', '2027-03-10', '2027-03-12', 8],
    ['opposition', '2027-02-11', '2027-02-11', 12],
    ['elongation', '2026-11-21', '2026-11-21', 20],
  ]
  for (const [eventType, dateStart, dateEnd, siteLimit] of cases) {
    // 即使显式传 tracker:false，也必须给赤道仪参数
    const r = await search({ eventType, dateStart, dateEnd, siteLimit, tracker: false, limit: 1, pageSize: 5 })
    assert.ok(r.ok, `${eventType}: ${r.message}`)
    const p = r.ranked[0].params
    assert.equal(p.rule, 'video', `${eventType} 应走视频叠加参数`)
    assert.equal(p.trackerRequired, true, `${eventType} 必须用赤道仪`)
    assert.equal(p.trackerNeeded, true)
    assert.match(p.exposureText, /^1\/20 s × \d+ 帧$/)
    assert.ok(p.exposureSec < 1, '行星单张是分数秒，不是几十秒')
    assert.equal(p.frames, 500)
    assert.equal(p.iso, 800, '行星亮，ISO 降到 800')
    assert.ok(!/短曝/.test(p.note), '不应再给无赤道仪方案')
    assert.match(p.hint, /行星类只给赤道仪参数/)
  }
})

test('合：焦段由两体张角反推（合月要把整轮月球装进去），长焦才上赤道仪', () => {
  // 广角端算例：角距 6° + 两侧行星半径 → 张角 6.06°，需要 9.7° 视场（画幅短边）
  const wide = conjunctionSetup({ event: { sepDeg: 6, objects: ['Jupiter', 'Mars'] } }, { format: 'ff' })
  assert.ok(Math.abs(wide.extent - 6.06) < 0.02, `张角 = 角距 + 两侧半径，实际 ${wide.extent}`)
  assert.ok(wide.focalFF[1] >= 100 && wide.focalFF[1] <= 200, `长焦端 ${wide.focalFF[1]}`)
  assert.equal(wide.trackerRequired, false, '焦段不长，不必上赤道仪')
  assert.ok(fieldOfView(wide.focalFF[1]) >= wide.extent, '长焦端视场要容得下张角')

  // 极小角距：金星合火星 0.31° → 撞到 2000mm 上限
  const tight = conjunctionSetup({ event: { sepDeg: 0.31, objects: ['Venus', 'Mars'] } }, { format: 'ff' })
  assert.equal(tight.focalFF[1], 2000)
  assert.ok(tight.focalFF[0] >= 1000)
  assert.equal(tight.trackerRequired, true, '两千毫米必须跟踪')
  assert.ok(fieldOfView(tight.focalFF[1]) >= tight.extent)

  // 含月亮：框以中点为心，两侧各留一个半径 → 张角 = 角距 + 2 × 0.26°
  const moon = conjunctionSetup({ event: { sepDeg: 0.9, objects: ['Jupiter', 'Moon'] } }, { format: 'ff' })
  assert.equal(moon.moonInvolved, true)
  assert.ok(Math.abs(moon.extent - 1.42) < 0.01, `张角应含两侧月面半径，实际 ${moon.extent}`)
  assert.equal(moon.trackerRequired, false, '月球定曝光，长焦也不用跟踪')
  assert.ok(fieldOfView(moon.focalFF[1]) >= moon.extent, '长焦端视场要容得下角距 + 月面半径')
  // 同样的角距，含月球时焦段必须更短（月球占掉一圈画面）
  const planetOnly = conjunctionSetup({ event: { sepDeg: 0.9, objects: ['Jupiter', 'Mars'] } }, { format: 'ff' })
  assert.ok(moon.focalFF[1] < planetOnly.focalFF[1], `月球占画面，合月焦段应更短：${moon.focalFF[1]} vs ${planetOnly.focalFF[1]}`)
  assert.ok(fieldOfView(planetOnly.focalFF[1]) >= planetOnly.extent)
})

test('合：检索结果带上角距、同框焦段与赤道仪判断', async () => {
  const wide = await search({ eventType: 'conjunction', dateStart: '2027-01-01', dateEnd: '2027-12-31', limit: 200, siteLimit: 5 })
  assert.ok(wide.ok, wide.message)
  // 参数用的角距是「可见时段里两颗最近」的那一个（事件峰值可能在白天），焦段必须按它给
  const w = wide.ranked.filter((x) => x.target.name === '火星合月' && x.params.conjunction.sep < 8)[0]
  assert.ok(w, '应找到一次靠得较近的火星合月')
  assert.equal(w.params.rule, 'moon', '有月球时按 Looney 11 定曝光')
  assert.equal(w.params.iso, 400)
  assert.equal(w.params.trackerRequired, false)
  assert.ok(w.params.ffFocal.endsWith('mm'))
  const [, hi] = w.params.ffFocal.replace('mm', '').split('–').map(Number)
  // 合月要把整轮月球装进去：框以中点为心 → 张角 = 角距 + 两侧月面半径
  assert.ok(Math.abs(w.params.conjunction.extent - (w.params.conjunction.sep + 0.52)) < 0.02, '张角应含两侧月面半径')
  assert.ok(fieldOfView(hi) >= w.params.conjunction.extent, '长焦端视场要容得下角距 + 两侧月面半径')
  assert.match(w.params.hint, /整轮月球/)
  assert.match(w.params.hint, /不用赤道仪/)

  // 每一行「合」都要满足：长焦端视场 ≥ 张角（也就是画面里一定装得下两颗）
  for (const x of wide.ranked.filter((r2) => r2.params.conjunction)) {
    const fMax = Number(x.params.ffFocal.split('–')[1].replace('mm', ''))
    assert.ok(fieldOfView(fMax) >= x.params.conjunction.extent,
      `${x.target.name} 长焦端 ${fMax}mm 视场装不下张角 ${x.params.conjunction.extent}°`)
  }

  // 金星合火星：角距 0.31° → 1100–2000mm + 赤道仪 5 s × 20 张
  const tight = wide.ranked.find((x) => x.target.name === '金星合火星')
  assert.ok(tight, '应找到金星合火星')
  assert.equal(tight.params.rule, 'tracker')
  assert.equal(tight.params.trackerRequired, true)
  assert.equal(tight.params.exposureText, '5 s × 20 张')
  assert.equal(tight.params.iso, 800)
  assert.ok(Number(tight.params.ffFocal.split('–')[1].replace('mm', '')) >= 1000)
  assert.match(tight.params.hint, /必须上赤道仪/)
})

test('参数：月食 / 日食不套 500 法则，改用 Looney 11 与巴德膜经验值', async () => {
  // 月食：满月基准 f/11·ISO 100 = 1/100 s → f/5.6·ISO 400 ≈ 1/1543 s；全食再压暗 13 档 → 约 5.3 s
  const lunar = await search({ eventType: 'lunarEclipse', dateStart: '2026-03-03', dateEnd: '2026-03-03', pageSize: 200 })
  assert.ok(lunar.ok, lunar.message)
  for (const x of lunar.ranked) {
    const p = x.params
    assert.equal(p.rule, 'moon', '月食应走 Looney 11')
    assert.equal(p.iso, 400)
    assert.equal(p.aperture, 'f/5.6')
    // 曝光写成「a–b s」（食分接近 0 时区间退化为单值）
    assert.match(p.exposureText, /^(1\/\d+|\d+(\.\d+)?)(–(1\/\d+|\d+(\.\d+)?))? s$/)
    assert.match(p.hint, /Looney 11/, '月食的依据应是 Looney 11')
    assert.match(p.hint, /满月 1\/\d+ s/, '依据里应给出满月基准曝光')
    assert.ok(p.exposureSec > 0 && p.exposureSec < 60, `月食曝光在毫秒到几秒之间，实际 ${p.exposureSec}`)
    assert.ok(Number.isFinite(p.obscuration) && p.obscuration >= 0 && p.obscuration <= 1, '应带等效食分')
    assert.ok(p.exposureRange.min <= p.exposureSec && p.exposureSec <= p.exposureRange.max, '代表值应落在区间内')
  }
  const darkest = lunar.ranked.reduce((a, b) => (b.params.exposureSec > a.params.exposureSec ? b : a))
  assert.ok(darkest.params.exposureSec > 1, `全食阶段应到秒级，实际 ${darkest.params.exposureSec}`)
  const brightest = lunar.ranked.reduce((a, b) => (b.params.exposureSec < a.params.exposureSec ? b : a))
  assert.ok(brightest.params.exposureSec < 0.01, '几乎没过食的站点仍是毫秒级')

  // 日食：巴德膜 ND5 下 f/8·ISO 400 → 1/4000 s（旧 500 法则会给 1 s，直接过曝到全白）
  const solar = await search({ eventType: 'solarEclipse', location: '新疆', dateStart: '2027-08-02', dateEnd: '2027-08-02', pageSize: 3 })
  assert.ok(solar.ok, solar.message)
  const sp = solar.ranked[0].params
  assert.equal(sp.rule, 'sun')
  assert.equal(sp.iso, 400)
  assert.equal(sp.exposureText, '1/8000–1/2000 s', '日面曝光给 ±1 档区间')
  assert.match(sp.hint, /巴德膜 ND5/, '日食的依据应是巴德膜经验值')
  assert.match(sp.hint, /全食摘膜后/, '应提示全食阶段摘膜')
  assert.ok(sp.exposureSec < 0.01, '日面曝光是毫秒级')
})

test('几何：最高高度带「最高点那一刻」的方位', async () => {
  // 行星上中天在正南：最高点的方位角应该落在 180° 附近，方向名「南」
  const r = await search({ eventType: 'planet', dateStart: '2027-03-10', dateEnd: '2027-03-12', limit: 1, siteLimit: 6 })
  assert.ok(r.ok, r.message)
  const g = r.ranked[0].geometry
  assert.ok(Number.isFinite(g.azMax), 'geometry.azMax 应是数字')
  assert.ok(g.azMax >= 0 && g.azMax < 360)
  assert.equal(g.directionAtMax, '南')
  assert.ok(Math.abs(g.azMax - 180) <= 40, `最高点方位应接近正南，实际 ${g.azMax}°`)
  // 恒星/深空同样带 azMax（上中天在正南或正北）
  const deep = await search({ eventType: 'deepsky', location: '海坨山', ...FAR, limit: 1 })
  assert.ok(deep.ok, deep.message)
  assert.ok(Number.isFinite(deep.ranked[0].geometry.azMax))
  assert.ok(typeof deep.ranked[0].geometry.directionAtMax === 'string')
})

test('参数：光圈只给一个 f 值，不出现「原生焦距」说明', async () => {
  const r = await search({ eventType: 'deepsky', location: '海坨山', ...FAR, limit: 3 })
  assert.ok(r.ok, r.message)
  assert.match(r.ranked[0].params.aperture, /^f\/\d+(\.\d+)?$/)
  // 行星/合/大距此前是「原生焦距 + 2× 巴洛」，现在也必须是纯 f 值
  const planet = await search({ eventType: 'planet', dateStart: '2027-03-10', dateEnd: '2027-03-12', siteLimit: 8, pageSize: 8 })
  const conj = await search({ eventType: 'conjunction', dateStart: '2026-11-16', dateEnd: '2026-11-16', limit: 2, siteLimit: 12 })
  for (const res of [planet, conj]) {
    assert.ok(res.ok, res.message)
    for (const x of res.ranked) {
      assert.match(x.params.aperture, /^f\/\d+(\.\d+)?$/, `光圈应为纯 f 值，实际 ${x.params.aperture}`)
      assert.ok(!/原生焦距/.test(x.params.aperture))
    }
  }
})

test('时间轴：包含暮光、月况与逐小时目标', () => {
  const r = timeline('haituo', '2026-11-13')
  assert.ok(r.ok)
  assert.equal(r.context.dusk, '18:35')
  assert.ok(r.context.moonIllum > 10 && r.context.moonIllum < 25)
  assert.ok(r.hours.length === 24)
  assert.ok(r.hours.some((h) => h.top.length > 0))
  // 02:00 前后应有猎户座目标在地平线上
  const h2 = r.hours.find((h) => h.time === '02:00')
  assert.ok(h2.top.length >= 1)
  assert.ok(h2.top.every((t) => t.alt >= 25))
})

test('时间轴：未知站点报错', () => {
  const r = timeline('not-a-site', '2026-11-13')
  assert.equal(r.ok, false)
  assert.equal(r.error, 'no_site')
})

test('天气评分：晴朗 > 阴沉，露点差扣分', () => {
  const base = {
    hourly: {
      time: Array.from({ length: 48 }, (_, i) => {
        const day = i < 24 ? '2026-11-12' : '2026-11-13'
        return `${day}T${String(i % 24).padStart(2, '0')}:00`
      }),
      cloud_cover: [], cloud_cover_low: [], cloud_cover_mid: [], cloud_cover_high: [],
      precipitation_probability: [], relative_humidity_2m: [], dew_point_2m: [],
      temperature_2m: [], wind_speed_10m: [], visibility: [],
    },
  }
  const make = (cloud, dewGap) => {
    const h = JSON.parse(JSON.stringify(base))
    for (let i = 0; i < 48; i += 1) {
      h.hourly.cloud_cover.push(cloud)
      h.hourly.cloud_cover_low.push(cloud)
      h.hourly.cloud_cover_mid.push(cloud)
      h.hourly.cloud_cover_high.push(cloud)
      h.hourly.precipitation_probability.push(cloud > 50 ? 60 : 0)
      h.hourly.relative_humidity_2m.push(60)
      h.hourly.dew_point_2m.push(0 - dewGap)
      h.hourly.temperature_2m.push(0)
      h.hourly.wind_speed_10m.push(5)
      h.hourly.visibility.push(20000)
    }
    return h
  }
  const clear = scoreNight(make(0, 10), '2026-11-12')
  const cloudy = scoreNight(make(90, 10), '2026-11-12')
  const dewy = scoreNight(make(0, 1), '2026-11-12')
  assert.ok(clear.score > cloudy.score, '晴天应高于阴天')
  assert.ok(clear.score > dewy.score, '露点差小应扣分')
  assert.ok(clear.score >= 95, '全晴应接近满分')
})

test('元数据：站点/省份/类型/天气覆盖齐全', () => {
  const m = meta()
  assert.ok(m.stats.total >= 90)
  assert.ok(m.stats.provinces >= 30)
  const ids = m.eventTypes.map((t) => t.id)
  for (const need of ['meteor', 'solarEclipse', 'lunarEclipse', 'opposition', 'conjunction', 'aurora', 'zodiacal']) {
    assert.ok(ids.includes(need), `类型列表缺少 ${need}`)
  }
  assert.ok(!ids.includes('moon'), '月景类型应已移除')
  assert.equal(m.eventTypes.find((t) => t.id === 'solarEclipse').label, '日食')
  assert.equal(m.eventTypes.find((t) => t.id === 'lunarEclipse').label, '月食')
  assert.ok(m.sites.length === m.stats.total)
  assert.ok(m.targets.length >= 30)
  assert.match(m.weather.from, /^\d{4}-\d{2}-\d{2}$/)
})

test('天象类型按 星野/日月/行星/深空 分组', () => {
  const m = meta()
  assert.deepEqual(m.eventTypeGroups.map((g) => g.label), ['星野', '日月', '行星', '深空'])
  const groupOf = (id) => m.eventTypes.find((t) => t.id === id).group
  for (const id of ['meteor', 'comet', 'milkyway', 'zodiacal', 'aurora', 'startrail']) assert.equal(groupOf(id), 'nightscape', id)
  for (const id of ['solarEclipse', 'lunarEclipse']) assert.equal(groupOf(id), 'sunmoon', id)
  // 行星组：冲日 → 大距 → 合；「行星」这个泛化类型已改为「大距」
  // 行星组：单个行星 → 冲日 → 大距 → 合
  assert.deepEqual(
    m.eventTypes.filter((t) => t.group === 'planet').map((t) => t.id),
    ['planet', 'opposition', 'elongation', 'conjunction'],
  )
  assert.equal(m.eventTypes.find((t) => t.id === 'planet').label, '单个行星')
  assert.equal(m.eventTypes.find((t) => t.id === 'elongation').label, '大距')
  // 深空：全部深空 + 四个细分
  assert.deepEqual(
    m.eventTypes.filter((t) => t.group === 'deepsky').map((t) => t.id),
    ['deepsky', 'deepskyGalaxy', 'deepskyNebula', 'deepskyCluster', 'deepskyPlanetary'],
  )
  assert.equal(m.eventTypes.find((t) => t.id === 'deepsky').label, '全部深空')
  assert.equal(m.eventTypes.find((t) => t.id === 'comet').label, '彗星')
  assert.equal(groupOf('any'), null)
})

test('默认最低高度角为 0：地平线以上即可参与评估', async () => {
  assert.equal(parseOptions({}).minAltitude, 0, 'minAltitude 默认应为 0')
  assert.equal(parseOptions({ minAltitude: 0 }).minAltitude, 0, '0 不能被默认值吞掉')
  assert.equal(parseOptions({ minAltitude: 25 }).minAltitude, 25, '显式值应生效')

  // 默认（0°）比抬高门槛（40°）能容纳更多低高度候选
  const low = await search({ eventType: 'deepsky', dateStart: '2027-03-10', dateEnd: '2027-03-12', siteLimit: 12, pageSize: 3 })
  const high = await search({ eventType: 'deepsky', dateStart: '2027-03-10', dateEnd: '2027-03-12', siteLimit: 12, pageSize: 3, minAltitude: 40 })
  assert.ok(low.ok && high.ok)
  assert.ok(low.poolSize.candidates > high.poolSize.candidates,
    `0° 候选 ${low.poolSize.candidates} 应多于 40° 候选 ${high.poolSize.candidates}`)
})

test('光污染评分：波特尔越低分越高（B1=100 → B9=20）', async () => {
  const r = await search({ eventType: 'deepsky', dateStart: '2027-03-10', dateEnd: '2027-03-10', siteLimit: 60, pageSize: 60, maxBortle: 9 })
  assert.ok(r.ok, r.message)
  for (const x of r.ranked) {
    assert.equal(x.breakdown.pollution, 100 - 10 * (x.site.bortle - 1), `B${x.site.bortle} 的光污染分不对`)
  }
  // 分档不同的行之间，越暗分越高（同档位自然同分）
  const byBortle = new Map()
  for (const x of r.ranked) byBortle.set(x.site.bortle, x.breakdown.pollution)
  const dark = Math.min(...byBortle.keys())
  const bright = Math.max(...byBortle.keys())
  assert.equal(byBortle.get(dark), 100 - 10 * (dark - 1))
  if (dark !== bright) assert.ok(byBortle.get(dark) > byBortle.get(bright), '越暗的站点分越高')
})

test('地景评分：不可替代性越高分越高', async () => {
  const r = await search({ eventType: 'deepsky', dateStart: '2027-03-10', dateEnd: '2027-03-12', siteLimit: 60, pageSize: 60 })
  assert.ok(r.ok, r.message)
  for (const x of r.ranked) {
    const fg = x.foreground
    assert.ok(fg.sharedBy >= 0)
    assert.ok(fg.irreplaceability >= 0 && fg.irreplaceability <= 100)
    // 分数 = 方位吻合度 × (0.55 + 0.45 × 不可替代性)
    const expect = (fg.match / 100) * (0.55 + 0.45 * (fg.irreplaceability / 100)) * 100
    assert.ok(Math.abs(fg.score - expect) < 1.5, `${fg.name} 得分 ${fg.score} 与公式 ${expect.toFixed(1)} 不一致`)
  }
  // 方位都快满分的两行里，独占机位应高于多处共用的通用地景
  const tight = r.ranked.filter((x) => x.foreground.match >= 95 && x.foreground.name)
  if (tight.length >= 2) {
    const unique = tight.filter((x) => x.foreground.sharedBy === 1).sort((a, b) => b.foreground.score - a.foreground.score)[0]
    const common = tight.filter((x) => x.foreground.sharedBy >= 3).sort((a, b) => a.foreground.score - b.foreground.score)[0]
    if (unique && common) {
      assert.ok(unique.foreground.score > common.foreground.score,
        `独占地景 ${unique.foreground.name}(${unique.foreground.score}) 应高于共用 ${common.foreground.name}(${common.foreground.score})`)
    }
  }
})

test('深空细分：星系 / 星云 / 星团 / 行星状星云 各自只返回对应目标', async () => {
  const cases = [
    ['deepskyGalaxy', 'galaxy'],
    ['deepskyNebula', 'nebula'],
    ['deepskyCluster', 'cluster'],
    ['deepskyPlanetary', 'planetary'],
  ]
  for (const [type, subtype] of cases) {
    const r = await search({ eventType: type, dateStart: '2027-08-10', dateEnd: '2027-08-20', siteLimit: 8, pageSize: 6 })
    assert.ok(r.ok, `${type}: ${r.message}`)
    for (const x of r.ranked) {
      assert.equal(x.target.type, 'deepsky')
      assert.equal(x.target.subtype, subtype, `${type} 返回了 ${x.target.name}`)
    }
  }
})

test('彗星：视星等 ≤ 9、距日 ≥ 10°，越亮 / 离太阳越远天象分越高', async () => {
  const r = await search({ eventType: 'comet', dateStart: '2028-05-20', dateEnd: '2028-06-10', siteLimit: 10, pageSize: 8 })
  assert.ok(r.ok, r.message)
  for (const x of r.ranked) {
    assert.equal(x.target.type, 'comet')
    assert.ok(x.target.mag <= 9, `${x.target.name} 视星等 ${x.target.mag} 超过 9`)
    assert.ok(x.target.elongation >= 10, `${x.target.name} 距日角 ${x.target.elongation}° 太小`)
    assert.match(x.target.name, /等）$/, '目标名里应带视星等')

    // 天象分 = 35 + 40×(9.5−视星等)/9.5 + 25×(距日−10)/90
    const bright = Math.min(1, Math.max(0, (9.5 - x.target.mag) / 9.5))
    const away = Math.min(1, Math.max(0, (x.target.elongation - 10) / 90))
    const expect = 35 + 40 * bright + 25 * away
    assert.ok(Math.abs(x.breakdown.event - expect) < 2, `${x.target.name} 天象分 ${x.breakdown.event}，公式 ${expect.toFixed(1)}`)
  }

  // 越亮分越高：同一颗彗星不同夜晚的亮度差要反映到天象分上
  const scores = r.ranked.map((x) => ({ mag: x.target.mag, event: x.breakdown.event }))
  const brightest = scores.reduce((a, b) => (b.mag < a.mag ? b : a))
  const faintest = scores.reduce((a, b) => (b.mag > a.mag ? b : a))
  if (brightest.mag < faintest.mag) {
    assert.ok(brightest.event > faintest.event, `更亮的 ${brightest.mag} 等应比 ${faintest.mag} 等天象分高`)
  }

  // 贴着太阳的彗星（C/2024 E1 约 5 等但只在白天时段升到地平线上）不出结果
  const sunHugger = await search({ eventType: 'comet', dateStart: '2026-01-20', dateEnd: '2026-02-05', siteLimit: 10 })
  assert.equal(sunHugger.ok, false)
  assert.equal(sunHugger.error, 'no_visible')
  assert.match(sunHugger.message, /距日|视星等/)
})

test('单个行星：只返回行星目标，且在行星组里排第一', async () => {
  const r = await search({ eventType: 'planet', dateStart: '2027-03-10', dateEnd: '2027-03-12', siteLimit: 8, pageSize: 8 })
  assert.ok(r.ok, r.message)
  const names = [...new Set(r.ranked.map((x) => x.target.name))]
  assert.ok(names.length > 0)
  for (const n of names) assert.match(n, /木星|火星|土星|金星/, `意外目标 ${n}`)
  assert.ok(r.ranked.every((x) => x.target.type === 'planet'))
  // 单个行星不是「事件型」，任意夜晚都应有结果
  const wide = await search({ eventType: 'planet', dateStart: '2027-03-10', dateEnd: '2027-03-14', siteLimit: 4, pageSize: 3 })
  assert.ok(wide.ok, wide.message)
  assert.ok(wide.pagination.total > 0)
})

test('可见窗口 / 最佳时段都带日期', async () => {
  const r = await search({ eventType: 'deepsky', dateStart: '2027-03-10', dateEnd: '2027-03-10', siteLimit: 4, pageSize: 2 })
  assert.ok(r.ok, r.message)
  for (const x of r.ranked) {
    assert.match(x.window.startAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, '可见窗口起点应带日期')
    assert.match(x.window.endAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, '可见窗口终点应带日期')
    assert.match(x.window.startShort, /^\d{2}-\d{2} \d{2}:\d{2}$/, '表格短格式应带月日')
    assert.match(x.window.endShort, /^\d{2}-\d{2} \d{2}:\d{2}$/, '表格短格式应带月日')
    assert.equal(x.window.startDate, '2027-03-10')
    // 跨零点的窗口，结束日期应是次日
    if (x.window.end < x.window.start) assert.equal(x.window.endDate, '2027-03-11')
  }
})

test('Bortle 复核提示挪到光污染行说明的末尾', async () => {
  const r = await search({ eventType: 'deepsky', dateStart: '2027-03-10', dateEnd: '2027-03-10', siteLimit: 4, pageSize: 2 })
  assert.ok(r.ok, r.message)
  const rd = r.ranked[0].reasonDetail
  assert.match(rd.pollution, /lightpollutionmap\.info/, '光污染行应带复核提示')
  assert.match(rd.pollution, /Bortle 为估算值/)
  assert.ok(rd.pollution.trim().endsWith('按坐标复核'), '提示应在该行说明的最后')
  assert.ok(!rd.foreground.includes('lightpollutionmap'), '地景行不应带复核提示')
})

test('行星 / 深空：地景不纳入评分，星级仍参与', async () => {
  const cases = [
    ['deepsky', 'deepskyGalaxy', 'planet'],
  ].flat()
  for (const type of cases) {
    const r = await search({ eventType: type, dateStart: '2027-03-10', dateEnd: '2027-03-10', siteLimit: 6, pageSize: 2 })
    assert.ok(r.ok, `${type}: ${r.message}`)
    for (const x of r.ranked) {
      assert.equal(x.breakdown.foreground, null, `${type} 的地景分应为 null`)
      assert.ok(x.breakdown.ignored.includes('foreground'), `${type} 应把地景标为不参与`)
      assert.match(x.reasonDetail.foreground, /地景不参与评分/)
    }
  }
  // 星野类（流星雨 / 银河）仍然计地景
  const meteor = await search({ eventType: 'meteor', dateStart: '2027-08-12', dateEnd: '2027-08-12', siteLimit: 4, pageSize: 2 })
  assert.ok(meteor.ok, meteor.message)
  assert.ok(meteor.ranked.every((x) => typeof x.breakdown.foreground === 'number'))
  assert.ok(meteor.ranked.every((x) => !x.breakdown.ignored.includes('foreground')))
})

test('缺维度时总分按剩余权重换算成百分制', async () => {
  const r = await search({ eventType: 'deepsky', dateStart: '2027-03-10', dateEnd: '2027-03-10', siteLimit: 6, pageSize: 3 })
  assert.ok(r.ok, r.message)
  for (const x of r.ranked) {
    const b = x.breakdown
    // 深空忽略地景、远期无天气 → 只剩「天象 / 光污染 / 月相」三个维度
    assert.ok(b.participating >= 2 && b.participating < 5, `参与维度数 ${b.participating} 不合理`)
    const dims = [
      [0.4, b.sky],
      [0.1, b.pollution],
      [0.1, b.moon],
      [0.2, b.weather],
      [0.2, b.foreground],
    ].filter(([, v]) => v !== null && v !== undefined)
    const sum = dims.reduce((a, [w]) => a + w, 0)
    const expect = dims.reduce((a, [w, v]) => a + w * v, 0) / sum
    assert.ok(Math.abs(x.score - expect) < 0.2, `总分 ${x.score} 应等于按 ${dims.length} 维归一后的 ${expect.toFixed(1)}`)
    assert.ok(x.score >= 0 && x.score <= 100, '总分必须落在 0–100')
  }
})

test('大距：在民用暮光里给水星/金星的可看时段', async () => {
  const r = await search({ eventType: 'elongation', dateStart: '2026-11-21', dateEnd: '2026-11-21', siteLimit: 60, pageSize: 5 })
  assert.ok(r.ok, r.message)
  assert.match(r.ranked[0].target.name, /大距/)
  assert.ok(r.ranked.every((x) => /水星|金星/.test(x.target.name)))
  // 大距目标贴着太阳：窗口必须落在晨昏（傍晚 16–24 点或凌晨 0–9 点）
  for (const x of r.ranked) {
    assert.ok(x.window.start <= '23:59' || x.window.start >= '03:00', `窗口 ${x.window.start} 不像晨昏时段`)
    assert.ok(x.geometry.altMax > 0, `高度 ${x.geometry.altMax} 应在地平线以上`)
  }
})

test('行星事件只在当天出现，不会在日期范围里每晚刷屏', async () => {
  const wide = await search({ eventType: 'opposition', dateStart: '2027-02-01', dateEnd: '2027-03-01', siteLimit: 6, pageSize: 20 })
  assert.ok(wide.ok, wide.message)
  const dates = [...new Set(wide.ranked.map((x) => x.date))]
  assert.ok(dates.every((d) => d === '2027-02-10' || d === '2027-02-11' || d === '2027-02-19'), `意外的日期：${dates.join(',')}`)
})

test('合：行星合月也进结果，且亮度/角距参与评分', async () => {
  const r = await search({ eventType: 'conjunction', dateStart: '2026-11-01', dateEnd: '2026-11-30', siteLimit: 10, pageSize: 20 })
  assert.ok(r.ok, r.message)
  const names = new Set(r.ranked.map((x) => x.target.name))
  assert.ok([...names].some((n) => /合月/.test(n)), `应包含行星合月：${[...names].join('/')}`)
  assert.ok(r.ranked.every((x) => x.breakdown.event > 0 && x.breakdown.event <= 100))
})

test('月食评分不含月相（月亮自己就是目标）', async () => {
  const r = await search({ eventType: 'lunarEclipse', dateStart: '2026-03-03', dateEnd: '2026-03-03', pageSize: 5 })
  assert.ok(r.ok, r.message)
  for (const x of r.ranked) {
    assert.equal(x.breakdown.moon, null, '月食不应有月相分')
    assert.ok(x.breakdown.ignored.includes('moon'), '月相应标记为不参与')
    assert.ok(x.breakdown.pollution > 0, '光污染仍然参与')
    assert.equal(x.reasonDetail.moon, '月食本身就是月球，月光不参与评分')
  }

  // 同样的「月亮在天上」条件，日食与月食的忽略维度不同
  const solar = await search({ eventType: 'solarEclipse', location: '新疆', dateStart: '2027-08-02', dateEnd: '2027-08-02', pageSize: 2 })
  assert.ok(solar.ok, solar.message)
  assert.deepEqual(solar.ranked[0].breakdown.ignored, ['pollution', 'moon'])
})

test('月食：月照度不改变最终评分（去月相前后一致）', async () => {
  const r = await search({ eventType: 'lunarEclipse', dateStart: '2026-03-03', dateEnd: '2026-03-03', pageSize: 200 })
  assert.ok(r.ok, r.message)
  const withWeather = r.ranked.filter((x) => x.breakdown.weather != null)
  if (withWeather.length > 0) {
    for (const x of withWeather.slice(0, 5)) {
      const recomputed = (
        0.4 * x.breakdown.sky + 0.1 * x.breakdown.pollution + 0.2 * x.breakdown.weather + 0.2 * x.breakdown.foreground
      ) / 0.9
      assert.ok(Math.abs(x.score - recomputed) < 0.2, `总分 ${x.score} 应等于去月相后的重归一 ${recomputed.toFixed(1)}`)
    }
  }
})

test('深空目标与站点库规模（扩库后）', () => {
  const m = meta()
  const ds = m.targets.filter((t) => t.type === 'deepsky')
  assert.ok(ds.length >= 40, `深空目标只有 ${ds.length} 个`)
  for (const subtype of ['galaxy', 'nebula', 'cluster', 'planetary']) {
    assert.ok(ds.filter((t) => t.subtype === subtype).length >= 5, `${subtype} 细分目标太少`)
  }
  assert.ok(m.stats.total >= 160, `站点只有 ${m.stats.total} 个`)
  assert.ok(m.stats.provinces >= 30)
})

test('日月食评分：全食高于偏食', async () => {
  // 同一次月全食里，能看全食阶段的站点 vs 只看到部分阶段（降级为偏食）的站点
  const total = await search({ eventType: 'lunarEclipse', dateStart: '2026-03-03', dateEnd: '2026-03-03', pageSize: 200 })
  assert.ok(total.ok, total.message)
  const full = total.ranked.filter((x) => /全食/.test(x.target.name))
  const partialOfSame = total.ranked.filter((x) => /偏食/.test(x.target.name))
  assert.ok(full.length > 0, '应有站点能看到完整全食阶段')
  assert.ok(partialOfSame.length > 0, '应有站点只看到部分阶段')
  assert.ok(full[0].breakdown.event > partialOfSame[0].breakdown.event,
    `全食 ${full[0].breakdown.event} 应高于偏食 ${partialOfSame[0].breakdown.event}`)

  // 跨事件的偏食（2028-07-06）也比不过全食
  const partial = await search({ eventType: 'lunarEclipse', dateStart: '2028-07-06', dateEnd: '2028-07-07', pageSize: 2 })
  assert.ok(partial.ok, partial.message)
  assert.match(partial.ranked[0].target.name, /偏食/)
  assert.ok(full[0].breakdown.event > partial.ranked[0].breakdown.event)
})

test('日食评分不含光污染与月相', async () => {
  const r = await search({ eventType: 'solarEclipse', location: '新疆', dateStart: '2027-08-02', dateEnd: '2027-08-02', pageSize: 3 })
  assert.ok(r.ok, r.message)
  const b = r.ranked[0].breakdown
  assert.equal(b.pollution, null)
  assert.equal(b.moon, null)
  assert.deepEqual(b.ignored, ['pollution', 'moon'])
  assert.ok(b.sky > 0 && b.foreground > 0)
})

test('分页：默认 20 条/页，翻页后序号连续', async () => {
  const base = { eventType: 'any', dateStart: '2027-03-10', dateEnd: '2027-03-12', siteLimit: 40 }
  const p1 = await search(base)
  assert.ok(p1.ok, p1.message)
  assert.equal(p1.pagination.pageSize, 20)
  assert.equal(p1.pagination.page, 1)
  assert.ok(p1.pagination.total > 20, `总数应超过一页，实际 ${p1.pagination.total}`)
  assert.equal(p1.ranked.length, 20)
  assert.equal(p1.ranked[0].rank, 1)

  const p2 = await search({ ...base, page: 2 })
  assert.ok(p2.ok, p2.message)
  assert.equal(p2.pagination.page, 2)
  assert.equal(p2.pagination.total, p1.pagination.total)
  assert.equal(p2.ranked[0].rank, 21)
  const key = (x) => `${x.site.id}|${x.target.id}|${x.date}`
  assert.ok(!p1.ranked.some((x) => key(x) === key(p2.ranked[0])), '第 2 页不应重复第 1 页内容')
})

test('日期校验：开始晚于结束、跨度超过一年都返回可读错误', async () => {
  const reversed = await search({ eventType: 'deepsky', dateStart: '2027-03-10', dateEnd: '2027-03-01' })
  assert.equal(reversed.ok, false)
  assert.equal(reversed.error, 'bad_range')
  assert.match(reversed.message, /晚于/)

  const tooLong = await search({ eventType: 'deepsky', dateStart: '2027-01-01', dateEnd: '2028-01-05' })
  assert.equal(tooLong.ok, false)
  assert.equal(tooLong.error, 'bad_range')
  assert.match(tooLong.message, /超过上限/)

  // 恰好一年（366 天，含首尾）允许
  const edge = await search({ eventType: 'deepsky', dateStart: '2027-01-01', dateEnd: '2028-01-01', siteLimit: 2, pageSize: 3 })
  assert.ok(edge.ok, edge.message)
})

test('长跨度搜索不再截断 60 夜：全部日期都参与评估', async () => {
  const r = await search({ eventType: 'deepsky', dateStart: '2027-03-01', dateEnd: '2027-04-30', siteLimit: 2, pageSize: 3 })
  assert.ok(r.ok, r.message)
  assert.ok(!r.notes.some((n) => n.includes('截断')), '不应再有 60 夜截断')
  // 2 站 × 61 夜
  assert.equal(r.poolSize.contexts, 2 * 61)
})

test('站点上限默认覆盖全部站点库，可用 siteLimit 调小', async () => {
  const all = await search({ eventType: 'deepsky', dateStart: '2027-03-10', dateEnd: '2027-03-10', pageSize: 1, maxBortle: 9 })
  assert.equal(all.poolSize.sites, catalog.SITES.length)

  const small = await search({ eventType: 'deepsky', dateStart: '2027-03-10', dateEnd: '2027-03-10', pageSize: 1, siteLimit: 5 })
  assert.equal(small.poolSize.sites, 5)
})

test('月食：一年内多次月食都要列出（含短半影食）', async () => {
  const r = await search({ eventType: 'lunarEclipse', dateStart: '2026-12-02', dateEnd: '2027-12-02', pageSize: 30 })
  assert.ok(r.ok, r.message)
  const dates = new Set(r.ranked.map((x) => x.date))
  assert.ok(dates.has('2027-02-20'), '应包含 2027-02-20 半影月食')
  assert.ok(dates.has('2027-07-18'), '应包含 2027-07-18 半影月食（此前因网格量化被丢掉）')
  assert.ok(r.pagination.total > 10, `候选应覆盖多个站点，实际 ${r.pagination.total}`)
})

test('月食：只见部分阶段时降级为偏食并给出食分', async () => {
  const r = await search({ eventType: 'lunarEclipse', dateStart: '2027-02-20', dateEnd: '2027-02-20', pageSize: 5, siteLimit: 30 })
  assert.ok(r.ok, r.message)
  assert.ok(r.ranked.some((x) => /仅见部分阶段|食分/.test(x.target.name)), '名称里应标注食分/部分可见')
})

test('日食：不在全食带内标为日偏食并带食分', async () => {
  const r = await search({ eventType: 'solarEclipse', location: '新疆', dateStart: '2027-08-02', dateEnd: '2027-08-02', pageSize: 5 })
  assert.ok(r.ok, r.message)
  assert.match(r.ranked[0].target.name, /^日偏食（食分 \d+%）$/)
})

test('评分为五维：天象/光污染/月相/天气/地景', async () => {
  const r = await search({ eventType: 'deepsky', ...FAR, limit: 2 })
  assert.ok(r.ok)
  const b = r.ranked[0].breakdown
  for (const key of ['sky', 'pollution', 'moon', 'weather', 'foreground']) {
    assert.ok(key in b, `breakdown 缺少 ${key}`)
  }
  assert.ok(b.sky >= 0 && b.sky <= 100)
  assert.ok(typeof r.ranked[0].reasonDetail.sky === 'string')
})

test('流星雨：ZHR 大的流星雨排在前面', async () => {
  // 12-13~12-16：双子（ZHR 120）与开始进入窗口的小熊（ZHR 10）同场
  const r = await search({
    eventType: 'meteor', dateStart: '2026-12-13', dateEnd: '2026-12-16', pageSize: 20, siteLimit: 6,
  })
  assert.ok(r.ok, r.message)
  const firstGeminid = r.ranked.findIndex((x) => x.target.name.includes('双子'))
  const firstUrsid = r.ranked.findIndex((x) => x.target.name.includes('小熊'))
  assert.ok(firstGeminid >= 0 && firstUrsid >= 0, `两场都应出现：${[...new Set(r.ranked.map((x) => x.target.name))].join('/')}`)
  assert.ok(firstGeminid < firstUrsid, 'ZHR 120 的双子应排在小熊之前')
})

test('长区间跨天气边界：不能只剩预报窗口内的流星雨', async () => {
  // 2026-11-07 起的大半年跨度，前 7 天有天气、之后没有；
  // 曾经的 bug：只要有任何一天取到天气，其余（无天气的）日期会被整段裁掉
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('offline in test') }
  try {
    const r = await search({
      eventType: 'meteor', dateStart: '2026-11-07', dateEnd: '2027-02-01', pageSize: 60, siteLimit: 3,
    })
    assert.ok(r.ok, r.message)
    const names = r.ranked.map((x) => x.target.name)
    for (const need of ['双子座', '象限仪', '狮子座', '小熊座']) {
      assert.ok(names.some((n) => n.includes(need)), `缺少 ${need}，实际：${[...new Set(names)].join('/')}`)
    }
  } finally {
    globalThis.fetch = realFetch
  }
})

test('月食闸门：没有月食的夜晚返回 no_event，而不是假结果', async () => {
  const none = await search({ eventType: 'lunarEclipse', dateStart: '2027-03-15', dateEnd: '2027-03-15', limit: 3 })
  assert.equal(none.ok, false)
  assert.equal(none.error, 'no_event')
  assert.match(none.message, /没有月食/)
  assert.match(none.message, /下一次日月食/)

  const real = await search({ eventType: 'lunarEclipse', dateStart: '2027-02-20', dateEnd: '2027-02-20', limit: 3, siteLimit: 20 })
  assert.ok(real.ok, real.message)
  assert.ok(real.ranked.every((x) => x.target.type === 'lunarEclipse'))
  assert.ok(real.ranked.every((x) => x.date === '2027-02-20'))
})

test('日食闸门：国内不可见的日食不给结果', async () => {
  const none = await search({ eventType: 'solarEclipse', dateStart: '2026-08-12', dateEnd: '2026-08-12', limit: 3 })
  assert.equal(none.ok, false)
  assert.equal(none.error, 'no_visible')
  assert.match(none.message, /不可见/)

  const partial = await search({
    eventType: 'solarEclipse', location: '新疆', dateStart: '2027-08-02', dateEnd: '2027-08-02', limit: 3,
  })
  assert.ok(partial.ok, partial.message)
  assert.ok(partial.ranked.length >= 1)
  assert.ok(partial.ranked[0].geometry.altMax > 20)
  assert.ok(partial.notes.some((n) => n.includes('巴德膜')))
})

test('极光：低纬站点直接拒绝，高纬站点要么有结果、要么明确说明 Kp 不足', async () => {
  const macau = await search({ eventType: 'aurora', location: '澳门', dateStart: '2026-11-25', dateEnd: '2026-11-25', limit: 3 })
  assert.equal(macau.ok, false)
  assert.equal(macau.error, 'no_aurora_site')

  // 漠河：结果取决于实时 Kp 预报——要么给结果，要么给出「Kp 不足/超出预报范围」的可读原因
  const mohe = await search({ eventType: 'aurora', location: '漠河', dateStart: '2026-11-25', dateEnd: '2026-11-25', limit: 3 })
  if (mohe.ok) {
    assert.equal(mohe.ranked[0].site.name, '漠河')
    assert.ok(mohe.notes.some((n) => n.includes('Kp')))
  } else {
    assert.ok(['no_visible', 'no_kp'].includes(mohe.error), `意外的错误 ${mohe.error}`)
    assert.match(mohe.message, /Kp/)
  }
})

test('黄道光：春季窗口与秋季窗口各自生效', async () => {
  const spring = await search({ eventType: 'zodiacal', dateStart: '2027-03-01', dateEnd: '2027-03-01', limit: 3, siteLimit: 20 })
  assert.ok(spring.ok, spring.message)
  assert.ok(spring.ranked.every((x) => x.target.name.includes('春季')))

  const autumn = await search({ eventType: 'zodiacal', dateStart: '2027-10-05', dateEnd: '2027-10-05', limit: 3, siteLimit: 20 })
  assert.ok(autumn.ok, autumn.message)
  assert.ok(autumn.ranked.every((x) => x.target.name.includes('秋季')))
})

test('冲日 / 合：事件当夜有结果，前后夜没有', async () => {
  const opp = await search({ eventType: 'opposition', dateStart: '2027-02-11', dateEnd: '2027-02-11', limit: 2, siteLimit: 12 })
  assert.ok(opp.ok, opp.message)
  assert.match(opp.ranked[0].target.name, /冲日/)

  const oppOff = await search({ eventType: 'opposition', dateStart: '2027-03-05', dateEnd: '2027-03-06', limit: 2, siteLimit: 6 })
  assert.equal(oppOff.ok, false)
  assert.equal(oppOff.error, 'no_event')

  const conj = await search({ eventType: 'conjunction', dateStart: '2026-11-16', dateEnd: '2026-11-16', limit: 2, siteLimit: 12 })
  assert.ok(conj.ok, conj.message)
  assert.match(conj.ranked[0].target.name, /合/)
})

test('any 类型不再每晚塞入月食目标', async () => {
  const r = await search({ eventType: 'any', dateStart: '2027-03-10', dateEnd: '2027-03-11', limit: 12, siteLimit: 10 })
  assert.ok(r.ok, r.message)
  assert.ok(r.ranked.every((x) => x.target.type !== 'lunarEclipse' && x.target.type !== 'moon'))
})

test('夜间网格受暮光约束', () => {
  const nc = astro.nightContext({ lat: 40.604, lon: 115.803, altM: 1800 }, '2026-11-13')
  const hours = (nc.dawn - nc.dusk) / 3600000
  assert.ok(hours > 9 && hours < 13, `暗夜时长 ${hours}h 不合理`)
})

test('直线距离：给出出发地时按大圆距离计算，未给出时为 null', async () => {
  const world = await search({ eventType: 'deepsky', ...FAR, limit: 3 })
  assert.ok(world.ranked.every((x) => x.distanceKm === null))

  const fromBeijing = await search({
    eventType: 'deepsky', location: '海坨山', ...FAR, limit: 2,
    originLat: 39.904, originLon: 116.407,
  })
  assert.ok(fromBeijing.ok)
  const km = fromBeijing.ranked[0].distanceKm
  assert.ok(Number.isFinite(km) && km > 60 && km < 140, `北京到海坨山应在 60–140km，实际 ${km}`)
  assert.equal(fromBeijing.ranked[0].site.distanceKm, km)
  assert.equal(fromBeijing.query.origin.lat, 39.904)
})

test('地点三级：地区→省份→站点 与 meta 结构一致', () => {
  const m = meta()
  assert.ok(m.provinces.every((p) => p.name && p.region))
  assert.ok(m.cities.length > 20)
  const qinghai = m.sites.filter((s) => s.province === '青海')
  assert.ok(qinghai.length >= 3)
  assert.ok(qinghai.every((s) => s.region === '西北'))
})

test('目标类型菜单去掉「深空·」前缀，结果行仍带细分前缀', async () => {
  const m = meta()
  const label = (id) => m.eventTypes.find((t) => t.id === id).label
  assert.equal(label('deepskyGalaxy'), '星系')
  assert.equal(label('deepskyNebula'), '星云')
  assert.equal(label('deepskyCluster'), '星团')
  assert.equal(label('deepskyPlanetary'), '行星状星云')
  const r = await search({ eventType: 'deepsky', ...FAR, siteLimit: 8, limit: 6 })
  assert.ok(r.ok, r.message)
  const row = r.ranked.filter((x) => x.target.type === 'deepsky')[0]
  assert.ok(row, '应有深空目标')
  assert.match(row.target.typeLabel, /^深空·(星系|星云|星团|行星状星云)$/, `行标签 ${row.target.typeLabel}`)
})

