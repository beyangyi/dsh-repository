/**
 * 页面脚本「真跑一遍」的冒烟测试：用最小 DOM 打桩执行 lib/webui.js 里的内联脚本，
 * 确认渲染路径没有 JS 错误，并且：
 *   - 结果表八列平均分配
 *   - 分页处有页码输入框 + 跳转按钮
 *   - 提示小字出现在表格之前、「点击行展开详情」的下一行
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

import { meta, search } from '../lib/planner.js'
import { page } from '../lib/webui.js'

function node(id) {
  return {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    style: {},
    disabled: false,
    children: [],
    appendChild(child) { this.children.push(child) },
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c) },
      remove(c) { this._s.delete(c) },
      contains(c) { return this._s.has(c) },
      toggle(c, on) {
        const want = on === undefined ? !this._s.has(c) : Boolean(on)
        if (want) this._s.add(c); else this._s.delete(c)
        return want
      },
    },
    scrollIntoView() {},
  }
}

function extractScript(html) {
  const start = html.indexOf('<script>') + '<script>'.length
  const end = html.lastIndexOf('</script>')
  assert.ok(start > 0 && end > start, '页面应内联一段脚本')
  return html.slice(start, end)
}

async function runPage() {
  const nodes = new Map()
  const doc = {
    head: { appendChild() {} },
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, node(id))
      return nodes.get(id)
    },
    createElement(tag) { return node(tag) },
  }
  const metaData = { ok: true, ...meta() }
  const searchData = await search({
    eventType: 'deepsky', dateStart: '2027-03-10', dateEnd: '2027-03-10', siteLimit: 2, pageSize: 3, withSim: true,
  })
  const store = new Map()
  const sandbox = {
    document: doc,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
    },
    navigator: {},
    fetch: async (url) => ({
      json: async () => (String(url).includes('/api/meta') ? metaData : searchData),
    }),
    console,
    setTimeout,
  }
  const source = extractScript(page())
    .replace(/\nboot\(\);\s*$/, '\nglobalThis.__bootPromise = boot();\nglobalThis.__runPageSearch = run;'
      + '\nglobalThis.__pickType = pickType; globalThis.__hoverTypeGroup = hoverTypeGroup;'
      + '\nglobalThis.__toggleTypeMenu = toggleTypeMenu; globalThis.__toggle = toggle;'
      + ' globalThis.__seekSim = seekSim; globalThis.__stopAllSims = stopAllSims;'
      + ' globalThis.__simDown = simDown; globalThis.__simMove = simMove; globalThis.__simUp = simUp;'
      + ' globalThis.__simWheel = simWheel; globalThis.__zoomSim = zoomSim; globalThis.__setMode = setMode;'
      + ' globalThis.__toggleTrack = toggleTrack;'
      + ' globalThis.__simReset = simReset; globalThis.__toggleSim = toggleSim; globalThis.__seekSim = seekSim;'
      + ' globalThis.__simState = function (i) { return sims[i]; };\n')
  assert.ok(source.includes('__bootPromise'), '应该能接管 boot() 的 Promise')
  const fn = new Function(...Object.keys(sandbox), source)
  fn(...Object.values(sandbox))
  await waitFor(globalThis, '__bootPromise')
  return { nodes, doc, searchData }
}

async function waitFor(scope, key) {
  for (let i = 0; i < 200; i += 1) {
    if (scope[key]) return scope[key]
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('页面脚本没有启动')
}

test('页面脚本可执行：结果表、分页跳转、提示位置都正确', async () => {
  const ctx = await runPage()
  await globalThis.__bootPromise

  // 启动时不自动检索：先看到空状态提示
  const list = ctx.doc.getElementById('list')
  assert.match(list.innerHTML, /点击「查询」开始检索/, '启动时不应自动出结果')
  assert.equal(ctx.doc.getElementById('stats').textContent, '', '启动时不该有候选统计')

  // 用户点「查询」后才渲染
  await globalThis.__runPageSearch()
  await new Promise((r) => setTimeout(r, 30))

  assert.ok(list.innerHTML.includes('220px'), '最佳时段列应有固定宽度')
  assert.ok(list.innerHTML.includes('目标类型'), '表头应有「目标类型」列')
  // 表头 8 列，且不再有「直线距离 / 天气」两列（便签里仍保留这两项信息）
  const headBlock = list.innerHTML.slice(0, list.innerHTML.indexOf('ritem'))
  assert.equal((headBlock.match(/class="hcell"/g) || []).length, 8, '表头应为 8 列')
  assert.ok(!headBlock.includes('直线距离'), '结果表不应再有「直线距离」列')
  assert.ok(!headBlock.includes('天气'), '结果表不应再有「天气」列')
  // 最佳时段一行显示完整起止（含月日），不再拆两行
  assert.match(list.innerHTML, /c-window[^>]*>03-\d{2} \d{2}:\d{2} → 03-\d{2} \d{2}:\d{2}</,
    '最佳时段应在同一行显示起止时间')
  assert.ok(list.innerHTML.includes('id="pageInput"'), '分页处应出现页码输入框')
  assert.ok(list.innerHTML.includes('跳转'), '分页处应出现跳转按钮')
  assert.ok(list.innerHTML.includes('推荐度明细与推荐理由'), '行内详情应渲染便签')
  // 第一行小字：数据库更新时间（彗星库周更）
  const hint = ctx.doc.getElementById('hint').textContent
  assert.match(hint, /^数据库 \d{4}-\d{2}-\d{2}/, '第一行小字应以「数据库 <时间> 更新」开头')
  assert.match(hint, /更新 · 站点库 \d+ 个 · 覆盖 \d+ 个省级行政区/, '数据库时间后面接站点概况')
  // 便签「最高高度」带上最高点那一刻的方位
  assert.match(list.innerHTML, /最高高度<\/span><b>\d+(\.\d+)?°（[北东南西]+ \d+°）<\/b>/,
    '最高高度应显示方位（方向名 + 方位角）')
  // 坐标用经纬度表述，而不是 "40.50, 115.83"
  assert.match(list.innerHTML, /坐标<\/span><b>北纬 \d+\.\d+° · 东经 \d+\.\d+°<\/b>/,
    '坐标应写成「北纬 xx° · 东经 xx°」')
  // 深空只给赤道仪参数：赤道仪「必须使用」+ 曝光依据
  assert.ok(list.innerHTML.includes('必须使用'), '深空/行星类赤道仪应为「必须使用」')
  assert.match(list.innerHTML, /曝光<\/span><b>120 s × 20 张<\/b>/, '深空曝光按赤道仪 120s × 20')
  assert.match(list.innerHTML, /赤道仪跟踪：单张 120 s，叠加 20 张/, '应写明曝光依据')

  const stats = ctx.doc.getElementById('stats')
  assert.match(stats.textContent, /候选 \d+ 条/, '应渲染候选统计')
  assert.match(stats.textContent, /点击行展开详情/, '第 2 行小字应包含点击提示')
  assert.match(page(), /<title>星野计划/, '页面标题应为星野计划')
  assert.match(page(), /<h1>星野计划 <small>by Sirius YANG<\/small><\/h1>/, '标题下应有 by Sirius YANG')
  delete globalThis.__bootPromise
})

test('目标类型：两级菜单（先选分组，再选具体类型）', async () => {
  const ctx = await runPage()
  await globalThis.__bootPromise

  const menu = ctx.doc.getElementById('typeMenu')
  const btn = ctx.doc.getElementById('typeBtn')
  const hidden = ctx.doc.getElementById('type')
  // 一级：四个分组 + 不限；二级：当前分组的具体类型
  const html = menu.innerHTML
  assert.ok(html.includes('tmenu-col'), '菜单应有两列')
  assert.ok(html.includes('tmenu-sub'), '右列是二级子菜单')
  for (const g of ['不限', '星野', '日月', '行星', '深空']) {
    assert.ok(html.includes(g), `一级菜单缺少「${g}」`)
  }
  assert.match(html, /data-id="nightscape"[^>]*onmouseenter=/, '一级项悬停切换分组')
  assert.equal(btn.textContent, '不限', '初始按钮显示「不限」')
  assert.equal(hidden.value, 'any', '隐藏字段初始为 any')

  // 悬停「深空」→ 二级换成深空的类型
  globalThis.__hoverTypeGroup('deepsky')
  assert.match(menu.innerHTML, /data-id="deepskyGalaxy"/, '深空分组下应有深空·星系')
  assert.ok(menu.innerHTML.includes('全部深空'))

  // 选「银河」→ 隐藏字段与按钮同步，菜单收起
  globalThis.__toggleTypeMenu()
  assert.equal(menu.style.display, 'flex', '点击按钮展开菜单')
  globalThis.__pickType('milkyway')
  assert.equal(hidden.value, 'milkyway', '选中后写回隐藏字段')
  assert.match(btn.textContent, /银河/, '按钮显示所选类型')
  assert.match(btn.textContent, /星野/, '按钮同时显示分组')
  assert.equal(menu.style.display, 'none', '选完自动收起')

  delete globalThis.__bootPromise
})

test('窄屏布局：画面模拟置顶占一行，其余便签移到它下方', () => {
  const css = readFileSync(join(ROOT, 'lib', 'webui.js'), 'utf8')
  assert.match(css, /@media \(max-width:1100px\)/u, '应有 1100px 断点')
  assert.match(css, /\.note \.notegrid\{grid-template-columns:1fr\}/u, '窄屏应为单列')
  assert.match(css, /\.note \.noteright\{order:-1;position:static;max-width:880px\}/u, '画面模拟应置顶并取消 sticky')
  assert.match(css, /\.note \.sec\.wide\{grid-column:1\/-1\}/u, '推荐度明细应占满整行')
  assert.ok(!css.includes('@media (max-width:900px){ .note .notegrid'), '旧的 900px 单列规则应已移除')
})

test('画面模拟：右侧整列，左侧 7 个便签（推荐度占两列），默认暂停在最佳时段开始', async () => {
  const ctx = await runPage()
  await globalThis.__bootPromise
  await globalThis.__runPageSearch()
  await new Promise((r) => setTimeout(r, 30))

  const list = ctx.doc.getElementById('list').innerHTML
  assert.ok(list.includes('notegrid'), '便签应是两列布局')
  const left = list.slice(list.indexOf('class="noteleft"'), list.indexOf('class="noteright"'))
  const right = list.slice(list.indexOf('class="noteright"'))
  assert.equal((left.match(/<h5>/g) || []).length, 7, '左侧应正好 7 个便签')
  assert.ok(!left.includes('距离与行程'), '距离与行程已并入地点')
  assert.ok(!list.includes('估算车程'), '不再显示估算车程')
  assert.ok(left.includes('直线距离') && left.includes('出发地'), '地点便签里合并直线距离与出发地')
  assert.ok(!left.includes('省份'), '地区与省份合并成一行')
  assert.match(left, /class="sec wide"/, '推荐度明细占两列宽')
  assert.ok(!left.includes('画面模拟（最佳时段）'), '画面模拟不应在左侧')
  assert.ok(right.includes('画面模拟（最佳时段）'), '画面模拟应在右列')
  assert.ok(right.indexOf('画面模拟（最佳时段）') > 0)
  assert.match(right, /<canvas id="sim0" class="simcanvas" width="960" height="540"/, '应有高清 canvas（自适应前的兜底尺寸）')
  assert.ok(right.includes('id="simbtn0"'), '应有播放按钮')
  assert.ok(right.includes('>播放<'), '默认不播放')
  assert.ok(right.includes('seekSim(0'), '应有进度拖动')
  assert.ok(right.includes('setMode(0'), '应有坐标系切换')
  assert.ok(!right.includes('openBig(0)'), '不再有放大按钮')
  assert.match(right, /地形：/, '说明里应带地景建模数据')
  assert.match(right, /\d+mm（[\d.]+°×[\d.]+°）/, '说明里应带焦段与视场')
  assert.match(right, /最佳时段 \d\d:\d\d–\d\d:\d\d/, '说明里应标出最佳时段')

  // 假 DOM 没有 canvas 2D 上下文：展开行不应抛错（假节点 style 是空对象，先补上初始 display）
  // 这里给 canvas 挂一个空上下文，才能拿到模拟状态
  const noop = () => {}
  ctx.doc.getElementById('sim0').getContext = () => ({
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    fillRect: noop, strokeRect: noop, fillText: noop, beginPath: noop, closePath: noop,
    moveTo: noop, lineTo: noop, arc: noop, fill: noop, stroke: noop, save: noop, restore: noop,
    clip: noop, setLineDash: noop, rect: noop, measureText: () => ({ width: 10 }),
  })
  ctx.doc.getElementById('det0').classList.remove('open')
  assert.doesNotThrow(() => globalThis.__toggle(0))
  assert.ok(ctx.doc.getElementById('det0').classList.contains('open'), '点开便签应加上 open（CSS 过渡展开）')
  assert.equal(globalThis.__simState(0).k, ctx.searchData.ranked[0].sim.startIndex, '默认停在最佳时段开始那一帧')
  assert.equal(globalThis.__simState(0).playing, false, '默认不播放')

  // 再点一次收起：class 来回切换，且内容一直在 DOM 里（过渡靠 CSS 高度动画）
  globalThis.__toggle(0)
  assert.equal(ctx.doc.getElementById('det0').classList.contains('open'), false, '再点一次应收起')
  const html = page(await search({ eventType: 'milkyway', withSim: false, limit: 1 }), meta())
  assert.ok(html.includes('grid-template-rows:0fr'), '收起有高度过渡（不是 display 硬切）')
  assert.ok(html.includes('grid-template-rows:1fr'), '展开有高度过渡')
  assert.ok(!/id="det\d+" style="display/.test(html), '便签不再用内联 display 硬切')
  // 画布位图尺寸跟随显示尺寸（按 DPR）：固定 960 被 CSS 拉大时平滑区会出现竖纹
  assert.ok(html.includes('fitSimCanvas'), '应有画布尺寸自适应')
  assert.ok(html.includes('devicePixelRatio'), '应按设备像素比放大位图')
  assert.ok(/w: canvas\.width,\s*\n?\s*h: canvas\.height/.test(html) || html.includes('w: canvas.width'), '渲染用画布的实际像素尺寸')

  delete globalThis.__bootPromise
})

test('画面模拟：滚轮缩放、坐标系切换', async () => {
  const ctx = await runPage()
  await globalThis.__bootPromise
  await globalThis.__runPageSearch()
  await new Promise((r) => setTimeout(r, 30))
  ctx.doc.getElementById('det0').classList.remove('open')
  const noop = () => {}
  ctx.doc.getElementById('sim0').getContext = () => ({
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    fillRect: noop, strokeRect: noop, fillText: noop, beginPath: noop, closePath: noop,
    moveTo: noop, lineTo: noop, arc: noop, fill: noop, stroke: noop, save: noop, restore: noop,
    clip: noop, setLineDash: noop, rect: noop, measureText: () => ({ width: 10 }),
  })
  try {
    globalThis.__toggle(0)
    const s = globalThis.__simState(0)
    assert.equal(s.mode, 'altaz')
    assert.doesNotThrow(() => globalThis.__simWheel({ deltaY: -400, preventDefault() {} }, 0))
    assert.ok(s.cam.fov >= 5 && s.cam.fov <= 180, `缩放应限制在 5°–180°，实际 ${s.cam.fov}`)
    assert.ok(s.cam.fov < 100, '向上滚应放大（视野变小）')
    // 缩放不再把机位改成"自由"，否则会从当前帧甩回默认机位
    assert.equal(s.cam.free, false, '缩放不应退出跟随 / 改变机位')
    globalThis.__zoomSim(0, -1)
    assert.ok(s.cam.fov > 5)
    assert.equal(s.cam.free, false)
    // 跟踪勾选框：打开=跟随（free 关掉），关闭=固定机位（free 打开，保持当前方向）
    assert.equal(typeof s.track, 'boolean')
    const before = s.track
    assert.doesNotThrow(() => globalThis.__toggleTrack(0, !before))
    assert.equal(s.track, !before, '勾选框应切换跟踪状态')
    assert.equal(s.cam.free, !s.track, '关掉跟踪才切到固定机位')
    globalThis.__toggleTrack(0, before)
    assert.equal(s.track, before)
    assert.equal(s.cam.free, !before)
    globalThis.__setMode(0, 'eq')
    assert.equal(s.mode, 'eq')
  } finally {
    globalThis.__stopAllSims()
  }
  delete globalThis.__bootPromise
})

test('画面模拟：重置回到打开时的画面（默认视角 + 最佳时段开始那帧）', async () => {
  const ctx = await runPage()
  await globalThis.__bootPromise
  await globalThis.__runPageSearch()
  await new Promise((r) => setTimeout(r, 30))
  ctx.doc.getElementById('det0').classList.remove('open')
  const noop = () => {}
  ctx.doc.getElementById('sim0').getContext = () => ({
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    fillRect: noop, strokeRect: noop, fillText: noop, beginPath: noop, closePath: noop,
    moveTo: noop, lineTo: noop, arc: noop, fill: noop, stroke: noop, save: noop, restore: noop,
    clip: noop, setLineDash: noop, rect: noop, measureText: () => ({ width: 10 }),
  })
  try {
    globalThis.__toggle(0)
    const s = globalThis.__simState(0)
    const start = Math.max(0, s.sim.startIndex || 0)
    assert.equal(s.k, start, '默认停在最佳时段开始那一帧')
    // 弄乱：换帧、换坐标系、转视角、放大
    globalThis.__seekSim(0, start + 3)
    globalThis.__setMode(0, 'eq')
    globalThis.__simDown({ clientX: 100, clientY: 100 }, 0)
    globalThis.__simMove({ clientX: 240, clientY: 60 }, 0)
    globalThis.__zoomSim(0, 1)
    assert.notEqual(s.k, start)
    assert.equal(s.mode, 'eq')
    assert.equal(s.cam.free, true)
    globalThis.__simReset(0)
    assert.equal(s.k, start, '重置后回到最佳时段开始那一帧')
    assert.equal(s.mode, 'altaz', '重置后回到地平坐标')
    assert.equal(s.cam.free, false, '重置后回到默认视角（跟随/初始机位）')
    assert.equal(s.cam.yaw, s.sim.camera.yaw)
    assert.equal(s.cam.pitch, s.sim.camera.pitch)
    assert.equal(s.cam.fov, s.sim.camera.fov)
    assert.equal(s.playing, false, '重置后不播放')
  } finally {
    globalThis.__stopAllSims()
  }
  delete globalThis.__bootPromise
})

test('画面模拟：绘制会裁剪天际线、标方位、显示日期与高度角', async () => {
  const ctx = await runPage()
  await globalThis.__bootPromise
  await globalThis.__runPageSearch()
  await new Promise((r) => setTimeout(r, 30))

  const sim = ctx.searchData.ranked[0].sim
  assert.ok(sim && sim.frames.length > 1)

  // 给假 canvas 挂一个记录调用的 2D 上下文
  const calls = []
  const stub = {
    createLinearGradient() { return { addColorStop() {} } },
    createRadialGradient() { return { addColorStop() {} } },
    fillRect(...a) { calls.push(['fillRect', ...a]) },
    strokeRect(...a) { calls.push(['strokeRect', ...a]) },
    fillText(t, x, y) { calls.push(['text', t, x, y]) },
    beginPath() { calls.push(['path']) }, closePath() {}, moveTo() {}, lineTo() {},
    arc() { calls.push(['arc']) }, fill() {}, stroke() {}, save() {}, restore() {},
    clip() { calls.push(['clip']) }, setLineDash() {}, rect() {},
  }
  const canvas = ctx.doc.getElementById('sim0')
  canvas.width = 960
  canvas.height = 540
  canvas.getContext = () => stub

  ctx.doc.getElementById('det0').classList.remove('open')
  try {
    globalThis.__toggle(0)
    assert.ok(calls.some((c) => c[0] === 'clip'), '天空应裁在地景以上')
    assert.ok(calls.some((c) => c[0] === 'fillRect'), '应铺一层天空渐变')
    const texts = calls.filter((c) => c[0] === 'text').map((c) => c[1])
    // 默认停在第 startIndex 帧（最佳时段开始）
    const first = sim.frames[sim.startIndex]
    assert.ok(texts.some((t) => String(t).startsWith(first.d + ' ' + first.t)), `左上应显示月日与时刻，实际 ${texts.slice(0, 6).join('|')}`)
    assert.ok(texts.some((t) => String(t).includes('最佳时段内')), '默认帧应在最佳时段内')
    assert.ok(texts.some((t) => String(t).startsWith('高度角')), '左下应有高度角')
    assert.ok(texts.some((t) => String(t).startsWith('北纬')), '左下应有经纬度')
    assert.ok(texts.includes('黄道'), '应标出黄道')
    assert.ok(texts.some((t) => /^(高度|方位) /.test(String(t))), '网格线应标数值：' + texts.join('|'))

    // 拖到最佳时段内的帧：目标可见时画取景框，恒星/行星用 arc
    const inWin = sim.frames.findIndex((f) => f.w === 1)
    globalThis.__seekSim(0, inWin)
    const midTexts = calls.filter((c) => c[0] === 'text').map((c) => c[1])
    const mid = sim.frames[inWin]
    assert.ok(midTexts.some((t) => String(t).startsWith(mid.d + ' ' + mid.t)), '拖动后应显示对应帧')
    assert.ok(midTexts.some((t) => String(t).includes('最佳时段内')), '窗口内的帧应标「最佳时段内」')
    assert.ok(calls.filter((c) => c[0] === 'arc').length > 5, '应画星点/行星（arc）')

    // 拖拽转视角：改 yaw 后重绘不报错
    assert.doesNotThrow(() => globalThis.__simDown({ clientX: 10, clientY: 10 }, 0))
    assert.doesNotThrow(() => globalThis.__simMove({ clientX: 90, clientY: 40 }, 0))
    assert.doesNotThrow(() => globalThis.__simUp({}, 0))
  } finally {
    // 关掉逐帧定时器，否则测试进程不会退出
    globalThis.__stopAllSims()
  }

  delete globalThis.__bootPromise
})


test('页面脚本：便签里日食不出现被忽略的维度', async () => {
  const html = page()
  // 只做静态检查：渲染函数用 gradeRows 过滤 ignored
  assert.ok(html.includes('function gradeRows'), '应通过 gradeRows 统一过滤维度')
  assert.ok(html.includes('ignored.indexOf'), '应按 breakdown.ignored 跳过维度')
})
