/**
 * 生成「离线预览页」：把 /astro-plan/ 的 HTML 与真实检索结果打包成单文件，
 * 用 headless Edge 截图验收 UI（不需要启动 DSH 或任何服务）。
 *
 * 用法：node tools/make-preview.mjs <out.html> <eventType> [openRow]
 */

import { writeFileSync } from 'node:fs'

import { meta, search } from '../lib/planner.js'
import { page } from '../lib/webui.js'

const [out, eventType = 'deepsky', openRow = ''] = process.argv.slice(2)
if (!out) {
  console.error('用法：node tools/make-preview.mjs <out.html> <eventType> [openRow]')
  process.exit(1)
}

const QUERIES = {
  deepsky: { dateStart: '2027-03-10', dateEnd: '2027-03-12', siteLimit: 40, pageSize: 20 },
  comet: { dateStart: '2028-05-20', dateEnd: '2028-06-10', siteLimit: 40, pageSize: 20 },
  solarEclipse: { dateStart: '2027-08-02', dateEnd: '2027-08-02', siteLimit: 128, pageSize: 20 },
  elongation: { dateStart: '2026-10-01', dateEnd: '2026-12-31', siteLimit: 128, pageSize: 20 },
  conjunction: { dateStart: '2026-11-01', dateEnd: '2026-11-30', siteLimit: 40, pageSize: 20 },
}

const metaData = { ok: true, ...meta() }
const result = await search({ eventType, withSim: true, ...QUERIES[eventType] })
if (!result.ok) throw new Error(`${eventType} 检索失败：${result.message}`)

const stub = `
window.__PREVIEW__ = { meta: ${JSON.stringify(metaData)}, data: ${JSON.stringify(result)} };
window.fetch = function (url) {
  var payload = String(url).indexOf('/api/meta') >= 0 ? window.__PREVIEW__.meta : window.__PREVIEW__.data;
  return Promise.resolve({ json: function () { return Promise.resolve(payload); } });
};
if (navigator.geolocation) {
  navigator.geolocation.getCurrentPosition = function (ok, fail) { fail && fail(); };
}
setTimeout(function () {
  var t = document.getElementById('type');
  if (t) { t.value = ${JSON.stringify(eventType)}; }
  run();
  ${openRow ? `setTimeout(function(){ toggle(${Number(openRow)}); }, 120);` : ''}
}, 60);
`

const html = page().replace('</head>', `<script>${stub}</script></head>`)
writeFileSync(out, html)
console.log(`写出 ${out}（${eventType} · 共 ${result.pagination.total} 条 · 首页 ${result.ranked.length} 行）`)
