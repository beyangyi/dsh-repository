/**
 * dsh-astro-plan — HTTP API。
 *
 * 前缀 /astro-plan：
 *   GET /api/meta                        元数据（事件类型/区域/省份/站点/目标/天气覆盖）
 *   GET /api/search?...                  与工具同参的检索
 *   GET /api/night?site=&date=           单站单夜时间轴
 *   GET /astro-plan/                     自包含页面
 */

import { meta, search, timeline } from './planner.js'
import { page } from './webui.js'
import { searchPlaces } from './geocode.js'
import { getTile } from './tiles.js'
import { SITES, PROVINCES, CITIES } from './catalog.js'

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(html),
  })
  res.end(html)
}

function queryToOptions(url) {
  const q = url.searchParams
  const opt = {}
  for (const key of ['action', 'eventType', 'location', 'region', 'province', 'dateStart', 'dateEnd',
    'timeFrom', 'timeTo', 'format']) {
    if (q.get(key)) opt[key] = q.get(key)
  }
  for (const key of ['minAltitude', 'maxBortle', 'limit', 'page', 'pageSize', 'siteLimit', 'maxDriveHours', 'originLat', 'originLon']) {
    if (q.get(key) !== null && q.get(key) !== '') opt[key] = Number(q.get(key))
  }
  if (q.get('tracker') !== null) opt.tracker = q.get('tracker') === 'true' || q.get('tracker') === '1'
  // 页面需要「画面模拟」数据：默认开启，?withSim=0 可关（工具直连 search 时默认不算）
  opt.withSim = !(q.get('withSim') === '0' || q.get('withSim') === 'false')
  return opt
}

let geoCache = null
function readGeo() {
  if (geoCache) return geoCache
  try {
    const file = join(dirname(fileURLToPath(import.meta.url)), 'data', 'china.json')
    geoCache = JSON.parse(readFileSync(file, 'utf8'))
    return geoCache
  } catch {
    return null
  }
}

export function installApi(ctx) {
  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    try {
      if (path === '/astro-plan' || path === '/astro-plan/' || path === '/astro-plan/index.html') {
        sendHtml(res, 200, page())
        return
      }
      if (req.method === 'GET' && path === '/astro-plan/api/meta') {
        sendJson(res, 200, { ok: true, ...meta() })
        return
      }
      if (req.method === 'GET' && path === '/astro-plan/api/search') {
        const result = await search(queryToOptions(url))
        sendJson(res, result.ok ? 200 : 400, result)
        return
      }
      if (req.method === 'GET' && path === '/astro-plan/api/geo') {
        const geo = readGeo()
        if (!geo) { sendJson(res, 503, { ok: false, error: 'geo_missing', message: '离线地图数据缺失，请运行 node tools/build-china.mjs' }); return }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=86400' })
        res.end(JSON.stringify({ ok: true, ...geo }))
        return
      }
      if (req.method === 'GET' && path === '/astro-plan/api/geocode') {
        const q = url.searchParams.get('q') ?? ''
        if (!q.trim()) { sendJson(res, 400, { ok: false, error: 'bad_request', message: '需要 q 参数' }); return }
        const results = await searchPlaces(q, {
          sites: SITES, provinces: PROVINCES, cities: CITIES,
          localOnly: url.searchParams.get('local') === '1',
        })
        sendJson(res, 200, { ok: true, query: q, results })
        return
      }
      const tileMatch = /^\/astro-plan\/api\/tile\/(street|topo)\/(\d+)\/(\d+)\/(\d+)$/.exec(path)
      if (req.method === 'GET' && tileMatch) {
        const [, style, z, x, y] = tileMatch
        const tile = await getTile(style, Number(z), Number(x), Number(y))
        if (tile.status !== 200) { sendJson(res, tile.status, { ok: false, error: 'tile_unavailable', message: tile.error }); return }
        res.writeHead(200, {
          'content-type': tile.type ?? 'image/jpeg',
          'cache-control': 'public, max-age=604800',
          'x-tile-source': tile.source ?? 'unknown',
        })
        res.end(tile.body)
        return
      }
      if (req.method === 'GET' && path === '/astro-plan/api/night') {
        const site = url.searchParams.get('site')
        const date = url.searchParams.get('date')
        if (!site || !date) {
          sendJson(res, 400, { ok: false, error: 'bad_request', message: '需要 site 与 date 参数' })
          return
        }
        const result = timeline(site, date)
        sendJson(res, result.ok ? 200 : 404, result)
        return
      }
      sendJson(res, 404, { ok: false, error: 'not_found', message: `未知路径 ${path}` })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: 'internal', message: String(error?.message ?? error) })
    }
  }
  return ctx.webServer.register({ kind: 'prefix', path: '/astro-plan', handler })
}
