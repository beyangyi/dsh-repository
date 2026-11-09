/**
 * 生成《星野计划 · 用户指南》的配图：真实界面截图。
 *
 * 流程（每个场景）：
 *   1. 用 `page()` + 真实检索结果 + 注入的 fetch stub 写出离线 HTML；
 *   2. 无头 Edge `--dump-dom` 取回各裁切目标元素的 `getBoundingClientRect`；
 *   3. 无头 Edge `--screenshot` 以 DPR=2 截图；
 *   4. Pillow 按矩形裁切、Lanczos 降到 CSS 尺寸，存进 `docs/images/`。
 *
 * 用法：
 *   node tools/make-guide-images.mjs                 # 全量重出
 *   node tools/make-guide-images.mjs 03-note         # 只出某几张（按文件名前缀）
 *
 * 注意：沙箱里起不了 Edge（mojo 命名管道会被拦），需要 danger-full-access 批准一次。
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

import { meta, search } from '../lib/planner.js'
import { page } from '../lib/webui.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const OUT_DIR = join(ROOT, 'docs', 'images')
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PYTHON_CANDIDATES = [
  process.env.DSH_PYTHON,
  'C:\\Users\\Yang\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe',
  join(dirname(process.execPath), '..', 'python', 'python.exe'),
  'python',
].filter(Boolean)
const PYTHON = PYTHON_CANDIDATES.find((candidate) => candidate === 'python' || existsSync(candidate)) ?? 'python'
const VIEWPORT = { width: 1600, height: 1500 }
const SCALE = 2 // DPR：先按 2 倍渲染，裁切后再降采样，细节更实

/** 场景：每个场景出一张图。crop 是裁切框（CSS 像素），[top, bottom] 两个选择器取并集。 */
const SCENARIOS = [
  {
    file: '01-overview',
    eventType: 'deepsky',
    query: { dateStart: '2027-03-10', dateEnd: '2027-03-12', siteLimit: 40 },
    crop: ['header', '.panel'],
    note: '页头 + 查询区',
  },
  {
    file: '02-results',
    eventType: 'deepsky',
    query: { dateStart: '2027-03-10', dateEnd: '2027-03-12', siteLimit: 40 },
    crop: ['#stats', '#row7'],
    padRight: 170,
    note: '结果表 + 分页',
  },
  {
    file: '03-note',
    eventType: 'deepsky',
    query: { dateStart: '2027-03-10', dateEnd: '2027-03-12', siteLimit: 40 },
    actions: 'toggle(1)',
    crop: ['#det1'],
    note: '便签七区块',
  },
  {
    file: '04-sim-meteor',
    eventType: 'meteor',
    query: { dateStart: '2027-08-12', dateEnd: '2027-08-13', siteLimit: 40 },
    actions: "toggle(0); setTimeout(function(){ var r=document.getElementById('simrange0'); if(!r) return; var n=parseInt(r.max,10)||0; seekSim(0, Math.round(n*0.5)) }, 500)",
    crop: ['#det0 .noteright'],
    padRight: 104,
    note: '画面模拟：流星雨',
  },
  {
    file: '05-sim-equatorial',
    eventType: 'milkyway',
    query: { dateStart: '2027-06-10', dateEnd: '2027-06-12', siteLimit: 40 },
    actions: 'toggle(0); setTimeout(function(){ setMode(0, "eq") }, 400)',
    crop: ['#det0 .noteright'],
    padRight: 104,
    note: '画面模拟：赤道坐标',
  },
  {
    file: '06-sim-moon',
    eventType: 'conjunction',
    query: { dateStart: '2026-12-01', dateEnd: '2026-12-08', siteLimit: 40 },
    actions: "toggle(0); setTimeout(function(){ var t=document.getElementById('track0'); if(t && !t.checked){ t.checked=true; toggleTrack(0,true) } var r=document.getElementById('simrange0'); if(!r) return; var n=parseInt(r.max,10)||0; seekSim(0, Math.round(n*0.6)) }, 500)",
    crop: ['#det0 .noteright'],
    padRight: 104,
    note: '画面模拟：月相/同框',
    optional: true,
  },
  {
    file: '07-type-menu',
    eventType: 'deepsky',
    query: { dateStart: '2027-03-10', dateEnd: '2027-03-12', siteLimit: 40 },
    actions: 'toggleTypeMenu()',
    crop: ['header', '#typeMenu'],
    note: '目标类型两级菜单',
  },
  {
    file: '08-pager',
    eventType: 'deepsky',
    query: { dateStart: '2027-03-10', dateEnd: '2027-03-12', siteLimit: 40 },
    crop: ['#stats', '#list'],
    viewportHeight: 1850,
    note: '统计行 + 分页条',
  },
  {
    file: '08b-pager-detail',
    eventType: 'deepsky',
    query: { dateStart: '2027-03-10', dateEnd: '2027-03-12', siteLimit: 40 },
    crop: ['#list > .pager'],
    viewportHeight: 1850,
    note: '分页条细节',
  },
]

const only = process.argv.slice(2)
const selected = only.length ? SCENARIOS.filter((s) => only.some((prefix) => s.file.startsWith(prefix))) : SCENARIOS

function edge(args) {
  return spawnSync(EDGE, args, { encoding: 'utf8', timeout: 120000 })
}

async function buildHtml(scenario) {
  const metaData = { ok: true, ...meta() }
  const result = await search({ eventType: scenario.eventType, withSim: true, pageSize: 20, ...scenario.query })
  if (!result || result.ok === false) throw new Error(`${scenario.file}: 检索失败 ${result && result.message}`)
  const stub = `
window.__PREVIEW__ = { meta: ${JSON.stringify(metaData)}, data: ${JSON.stringify(result)} };
window.fetch = function (url) {
  var payload = String(url).indexOf('/api/meta') >= 0 ? window.__PREVIEW__.meta : window.__PREVIEW__.data;
  return Promise.resolve({ json: function () { return Promise.resolve(payload); } });
};
if (navigator.geolocation) navigator.geolocation.getCurrentPosition = function (ok, fail) { fail && fail(); };
function __guideRects() {
  var rects = {};
  ${JSON.stringify([...new Set(SCENARIOS.flatMap((sc) => sc.crop))])}.forEach(function (sel) {
    var el = document.querySelector(sel);
    if (!el) return;
    var r = el.getBoundingClientRect();
    rects[sel] = { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height };
  });
  document.documentElement.setAttribute('data-guide-rects', JSON.stringify(rects));
}
setTimeout(function () {
  var t = document.getElementById('type');
  if (t) t.value = ${JSON.stringify(scenario.eventType)};
  run();
  setTimeout(function () {
    try { ${scenario.actions ?? ''} } catch (err) { document.documentElement.setAttribute('data-guide-error', String(err)); }
    setTimeout(__guideRects, 1200);
  }, 600);
}, 60);
`
  return page().replace('</head>', `<script>${stub}</script></head>`)
}

function cropRect(rects, selectors, padRight = 0) {
  const boxes = selectors.map((sel) => rects[sel]).filter(Boolean)
  if (!boxes.length) return null
  const x = Math.min(...boxes.map((b) => b.x))
  const y = Math.min(...boxes.map((b) => b.y))
  const right = Math.max(...boxes.map((b) => b.x + b.w))
  const bottom = Math.max(...boxes.map((b) => b.y + b.h))
  const pad = 4
  return { x: Math.floor(x) - pad, y: Math.floor(y) - pad, w: Math.ceil(right - x) + pad * 2 + padRight, h: Math.ceil(bottom - y) + pad * 2 }
}

function pythonCrop(source, target, rect, width) {
  const script = `
import sys
from PIL import Image
src, dst, x, y, w, h, out_w = sys.argv[1], sys.argv[2], *[int(v) for v in sys.argv[3:8]]
img = Image.open(src)
img = img.crop((x, y, x + w, y + h))
if out_w and out_w < img.width:
    img = img.resize((out_w, round(img.height * out_w / img.width)), Image.LANCZOS)
img.save(dst, 'PNG', optimize=True)
print(f'{dst} {img.width}x{img.height}')
`
  const file = join(WORK, 'crop.py')
  writeFileSync(file, script)
  return spawnSync(PYTHON, [file, source, target, rect.x * SCALE, rect.y * SCALE, rect.w * SCALE, rect.h * SCALE, Math.min(rect.w, width)], {
    encoding: 'utf8',
    timeout: 120000,
  })
}

const WORK = join(tmpdir(), 'dsh-astro-guide-images')
mkdirSync(WORK, { recursive: true })
mkdirSync(OUT_DIR, { recursive: true })

if (!existsSync(EDGE)) {
  console.error(`✗ 找不到 Edge：${EDGE}`)
  process.exit(1)
}

const failures = []
for (const scenario of selected) {
  const html = join(WORK, `${scenario.file}.html`)
  writeFileSync(html, await buildHtml(scenario))
  const url = `file:///${html.replaceAll('\\', '/')}`
  const width = scenario.viewportWidth ?? VIEWPORT.width
  const height = scenario.viewportHeight ?? VIEWPORT.height
  const common = ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--window-size=${width},${height}`, '--virtual-time-budget=15000']

  const dump = edge([...common, '--dump-dom', url])
  const dom = dump.stdout ?? ''
  const match = dom.match(/data-guide-rects="([^"]+)"/)
  if (!match) {
    console.error(`✗ ${scenario.file}: 没拿到元素矩形（Edge 输出 ${(dump.stderr ?? '').slice(0, 160)}）`)
    failures.push(scenario.file)
    continue
  }
  const decoded = match[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&').replaceAll('&gt;', '>').replaceAll('&lt;', '<')
  const rects = JSON.parse(decoded)
  const rect = cropRect(rects, scenario.crop, scenario.padRight ?? 0)
  if (!rect) {
    console.error(`✗ ${scenario.file}: 裁切目标不存在`)
    failures.push(scenario.file)
    continue
  }

  const shot = join(WORK, `${scenario.file}.png`)
  edge(['--headless=new', '--disable-gpu', '--hide-scrollbars', `--window-size=${width},${height}`,
    `--force-device-scale-factor=${SCALE}`, '--virtual-time-budget=15000', `--screenshot=${shot}`, url])
  if (!existsSync(shot)) {
    console.error(`✗ ${scenario.file}: 截图失败`)
    failures.push(scenario.file)
    continue
  }

  const target = join(OUT_DIR, `${scenario.file}.png`)
  const cropped = pythonCrop(shot, target, rect, 1400)
  process.stdout.write(cropped.stdout ?? '')
  if (cropped.status !== 0) {
    console.error(`✗ ${scenario.file}: 裁切失败 ${cropped.error ? cropped.error.message : ''} ${(cropped.stderr ?? '').slice(0, 300)}`)
    failures.push(scenario.file)
  }
}

// 清理中间产物（截图原图可能几百 MB）
for (const name of readdirSync(WORK)) {
  if (name.endsWith('.png') || name.endsWith('.html')) rmSync(join(WORK, name), { force: true })
}

if (failures.length) {
  console.error(`✗ 失败 ${failures.length} 张：${failures.join(', ')}`)
  process.exit(1)
}
console.log(`✓ 配图已写入 ${OUT_DIR}`)
