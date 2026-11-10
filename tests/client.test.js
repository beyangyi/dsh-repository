import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

import { RENDER_SRC } from '../lib/skyview.js'

let captured = null
globalThis.window = globalThis.window ?? {}
globalThis.window.__ModuleLoader__ = {
  load(entry) { captured = entry },
}
globalThis.document = {
  head: { appendChild() {} },
  getElementById() { return null },
  createElement() { return {} },
}

await import('../lib/client.js')

const fakeReact = {
  createElement() { return null },
  useState(value) { return [value, () => {}] },
  useEffect() {},
}

const fakeRequire = (id) => (id === 'react' ? fakeReact : {})

test('客户端 bundle 使用 loader 线格式且 id 正确', () => {
  assert.ok(captured, 'window.__ModuleLoader__.load 应被调用')
  assert.equal(captured.id, 'dsh-astro-plan')
  assert.equal(typeof captured.factory, 'function')
})

test('客户端导出 name / inject / apply', () => {
  const mod = captured.factory(fakeRequire)
  assert.equal(mod.name, 'dsh-astro-plan')
  assert.deepEqual(mod.inject, ['slots'])
  assert.equal(typeof mod.apply, 'function')
})

test('客户端：目标类型也是两级菜单，不再用 optgroup', () => {
  const src = captured.factory.toString()
  assert.ok(src.includes('function TypeMenu'), '应有两级菜单组件')
  assert.ok(src.includes('ap-tmenu-col'), '左列：一级分组')
  assert.ok(src.includes('ap-tmenu-sub'), '右列：二级类型')
  assert.ok(src.includes('onMouseEnter'), '一级悬停切换二级')
  assert.ok(!src.includes('optgroup'), '不再用原生 optgroup')
})

test('客户端：3D 天球渲染器与右列布局', () => {
  const src = captured.factory.toString()
  assert.ok(src.includes('function SkySim'), '应有画面模拟组件')
  assert.ok(src.includes('ap-simcanvas') && src.includes('ap-simctl'), '应有画布与控制条样式')
  assert.ok(src.includes('function skyRender'), '应有 3D 天球渲染器')
  assert.ok(src.includes('skyEqToAltAz'), '渲染器应带赤道→地平')
  assert.ok(src.includes('ap-notegrid') && src.includes('ap-noteleft') && src.includes('ap-noteright'), '两列布局（模拟在右列）')
  assert.ok(src.includes('ap-nsec.wide'), '推荐度明细应占两列宽')
  assert.ok(!src.includes('ap-bigwrap'), '不再有点击放大浮层')
  assert.ok(src.includes('addEventListener(\'wheel\''), '应有滚轮缩放')
  assert.ok(src.includes('setMode(\'altaz\')') || src.includes("setMode('altaz')"), '应有坐标系切换')
  assert.ok(src.includes("h('div', { className: 'ap-field ap-tmenu-field' }"), '类型菜单容器用 div（label 会把点击转发回按钮）')
  assert.ok(src.includes('withSim'), '查询请求应带上 withSim')
  assert.ok(src.includes('直线距离') && src.includes("kv('出发地'"), '地点便签里合并直线距离与出发地（各占一行）')
  assert.ok(src.includes('--ap-note-bg1:#1b2230'), '深色模式下便签也是深色')
  assert.ok(src.includes('background:var(--ap-note-sec);color:var(--ap-note-kv-val)'), '控制按钮要用便签主题色，深色下未选中按钮也得看清')
  assert.ok(!src.includes('color:#3a3117;border:1px solid rgba(120,95,40'), '不再用写死的深棕字色')
  assert.ok(src.includes('startIndex'), '默认帧取自 sim.startIndex')
  assert.ok(src.includes('Math.max(5, Math.min(180'), '缩放范围 5°–180°')
  assert.ok(src.includes('height:16px;margin:0;padding:0;align-self:center'), '进度条与文字垂直居中（右侧不再翘起）')
  assert.ok(src.includes('ctx.font = font(7)'), '网格角度标注字号缩小')
  // 「重置」要回到打开时的画面：默认视角 + 最佳时段开始那一帧 + 不播放 + 地平坐标
  const resetBlock = src.slice(src.indexOf('function resetView()'), src.indexOf('function resetView()') + 300)
  assert.ok(resetBlock.includes('setCam(null)'), '重置要清掉自由视角')
  assert.ok(resetBlock.includes('setPlaying(false)'), '重置要停止播放')
  assert.ok(resetBlock.includes('setK(Math.max(0, (sim && sim.startIndex) || 0))'), '重置要回到最佳时段开始那一帧')
  assert.ok(resetBlock.includes("setMode('altaz')"), '重置要回到地平坐标')
  // 跟踪勾选框 + 缩放不改机位
  assert.ok(src.includes('ap-simchk'), '播放区应有「跟踪」勾选框')
  assert.ok(src.includes('tracker: tracker'), '跟踪状态要传给渲染器')
  assert.ok(src.includes('free: Boolean(cur.free)'), '缩放不应把相机改成自由视角（否则会甩回默认机位）')
  assert.ok(src.includes('setTracker(false)'), '手动拖拽应退出跟随')
  // 画布位图尺寸跟随显示尺寸（按 DPR），免得 CSS 拉伸放大在平滑区出竖纹
  assert.ok(src.includes('function fitCanvas()'), '应有画布尺寸自适应')
  assert.ok(src.includes('devicePixelRatio'), '应按设备像素比放大位图')
  assert.ok(src.includes('fitCanvas()') && src.includes('w: c.width'), '渲染前先按实际尺寸重排位图')
  assert.ok(src.includes("window.addEventListener('resize'"), '窗口尺寸变化要重排重画')

  // 与 lib/skyview.js 的 RENDER_SRC 逐行一致，防止两份漂移
  const a = src.indexOf('/* === SKY RENDERER START === */')
  const b = src.indexOf('/* === SKY RENDERER END === */')
  assert.ok(a > 0 && b > a, '应有渲染器标记')
  const got = src.slice(a + '/* === SKY RENDERER START === */'.length, b)
    .split('\n').map((line) => line.trim()).filter(Boolean).join('\n')
  const want = RENDER_SRC
    .split('\n').map((line) => line.trim()).filter(Boolean).join('\n')
  assert.equal(got, want, '客户端渲染器应与 lib/skyview.js 的 RENDER_SRC 一致（改完跑 tools/sync-sky-renderer.mjs）')
})

test('客户端：窄屏时画面模拟置顶，其余便签移到下方', () => {
  const src = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  assert.match(src, /@media \(max-width:1100px\)\{\.ap-notegrid\{grid-template-columns:1fr\}/u, 'Tab 应有同样的 1100px 单列规则')
  assert.match(src, /\.ap-noteright\{order:-1;position:static;max-width:880px\}/u, 'Tab 的画面模拟应置顶')
  assert.match(src, /\.ap-nsec\.wide\{grid-column:1\/-1\}/u, 'Tab 的宽区块应占满整行')
  assert.ok(!src.includes('@media (max-width:900px){.ap-notegrid'), '旧的 900px 规则应已移除')
})

test('客户端：便签展开/收起是过渡动画（不硬切）', () => {
  const src = captured.factory.toString()
  // CSS：grid-template-rows 0fr ↔ 1fr + 透明度过渡
  assert.ok(src.includes('grid-template-rows:0fr'), '收起用 0fr 起手')
  assert.ok(src.includes('grid-template-rows:1fr'), '展开用 1fr')
  assert.ok(/transition:grid-template-rows \.26s ease,opacity \.2s ease/.test(src), '应有高度与透明度过渡')
  assert.ok(src.includes('.ap-detail.open{grid-template-rows:1fr;opacity:1'), 'open 时才展开')
  assert.ok(src.includes('@keyframes ap-detail-in') && src.includes('@keyframes ap-detail-out'), '展开/收起都有动画（挂载即播）')
  assert.ok(src.includes('.ap-detail.closing{animation:ap-detail-out'), '收起时播反向动画')
  assert.ok(src.includes('.ap-detail>div{min-height:0;overflow:hidden}'), '内层要能收干净')
  // 收起时内容保留 240ms 再卸载
  assert.ok(src.includes('var [closing, setClosing] = React.useState(-1)'), '要有「正在收起」状态')
  assert.ok(/setTimeout\(function \(\) \{ setClosing\(-1\)/.test(src), '收起动画结束要清掉内容')
  assert.ok(/\}, 240\)/.test(src), '收起时长 240ms（比 260ms 的过渡略短）')
  assert.ok(src.includes("className: 'ap-detail' + (isOpen ? ' open' : '')"), '展开/收起只切 class')
  assert.ok(src.includes('function toggleRow(i)'), '点击行要改走 toggleRow')
})

test('apply 注册 conversation.view Tab 且 id/order 正确', () => {
  const mod = captured.factory(fakeRequire)
  const registered = []
  const ctx = {
    slots: {
      inject(name, cb) { assert.equal(name, 'conversation.view'); return cb() },
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
  mod.apply(ctx)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].options.name, 'conversation.view')
  assert.equal(registered[0].options.id, 'astro-plan')
  assert.equal(registered[0].options.order, 85)
  assert.equal(registered[0].options.label(), '星野计划')
  assert.equal(typeof registered[0].component, 'function')
})

test('apply 在没有 slots 的宿主上安全降级', () => {
  const mod = captured.factory(fakeRequire)
  assert.doesNotThrow(() => mod.apply({}))
  assert.doesNotThrow(() => mod.apply(null))
})
