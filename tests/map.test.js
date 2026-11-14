import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as catalog from '../lib/catalog.js'
import { localPlaces, remotePlaces, resetGeocodeCache, searchPlaces } from '../lib/geocode.js'
import { getTile, resetTileMemory, TILE_STYLES } from '../lib/tiles.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

test('地图数据：china.json 存在、体积与 bbox 合理', () => {
  const file = join(ROOT, 'lib', 'data', 'china.json')
  assert.ok(existsSync(file), '缺少 lib/data/china.json（先跑 node tools/build-china.mjs）')
  const size = statSync(file).size
  assert.ok(size < 200 * 1024, `china.json ${Math.round(size / 1024)} KB 太大`)
  const geo = JSON.parse(readFileSync(file, 'utf8'))
  assert.ok(Array.isArray(geo.bbox) && geo.bbox.length === 4)
  assert.ok(geo.provinces.length >= 30, `省级单元只有 ${geo.provinces.length}`)
  const [minLon, minLat, maxLon, maxLat] = geo.bbox
  assert.ok(minLon < 80 && maxLon > 125 && minLat < 10 && maxLat > 50, 'bbox 未覆盖中国范围')
})

test('自定义点：字段完整、id 含坐标、波特尔在 1–9', () => {
  const site = catalog.customSite({ lat: 38.737, lon: 93.332 })
  assert.equal(site.custom, true)
  assert.match(site.id, /^custom:38\.737,93\.332$/u)
  assert.ok(site.bortle >= 1 && site.bortle <= 9)
  assert.equal(site.coordConfidence, 'user')
  assert.equal(site.bortleConfidence, 'estimated')
  assert.ok(site.province && site.region)
  assert.ok(site.horizonFrom, '附近有站点时应借用其天际线')
  assert.match(site.note, /近似/u)
})

test('自定义点：指定波特尔优先，远处无站点时 horizonFrom 为空', () => {
  const near = catalog.customSite({ lat: 40.6, lon: 115.8, bortle: 2 })
  assert.equal(near.bortle, 2)
  const far = catalog.customSite({ lat: 0.5, lon: -160.5 })
  assert.equal(far.horizonFrom, null)
  assert.equal(far.province, '自定义')
})

test('地点解析：@lat,lon 走自定义点，旧写法仍取最近 5 站', () => {
  const custom = catalog.resolveLocation('@40.12,116.30')
  assert.equal(custom.sites.length, 1)
  assert.equal(custom.sites[0].custom, true)
  const legacy = catalog.resolveLocation('40.12,116.30')
  assert.equal(legacy.sites.length, 5)
  assert.ok(legacy.sites.every((site) => site.custom !== true))
})

test('检索：siteLat/siteLon 返回自定义点，非法坐标报 bad_coords', async () => {
  const { search } = await import('../lib/planner.js')
  const ok = await search({ eventType: 'deepsky', siteLat: 38.737, siteLon: 93.332, dateStart: '2026-11-15', dateEnd: '2026-11-17', pageSize: 3 })
  assert.equal(ok.ok, true)
  assert.ok(ok.ranked.length > 0)
  assert.equal(ok.ranked[0].site.custom, true)
  assert.ok(ok.notes.some((note) => note.includes('近似')), '应说明近似口径')
  const bad = await search({ eventType: 'any', siteLat: 999, siteLon: 0, dateStart: '2026-11-15', dateEnd: '2026-11-16' })
  assert.equal(bad.ok, false)
  assert.equal(bad.error, 'bad_coords')
  assert.match(bad.message, /-90~90/u)
})

test('地点搜索：本地站点/省份/城市命中且排序合理', () => {
  const opts = { sites: catalog.SITES, provinces: catalog.PROVINCES, cities: catalog.CITIES }
  const site = localPlaces('海坨', opts)
  assert.ok(site.length > 0 && site[0].source === 'site')
  assert.ok(site[0].name.includes('海坨'))
  const province = localPlaces('青海', opts)
  assert.ok(province.some((item) => item.source === 'province' || item.source === 'city'))
  const city = localPlaces('北京市', opts)
  assert.ok(city.length > 0)
})

test('地点搜索：远端解析与超时降级', async () => {
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return {
      ok: true,
      json: async () => ({ results: [{ name: '冷湖', latitude: 38.737, longitude: 93.332, admin1: '青海', country: '中国' }] }),
    }
  }
  try {
    resetGeocodeCache()
    const results = await remotePlaces('冷湖')
    assert.equal(results.length, 1)
    assert.equal(results[0].source, 'geonames')
    assert.ok(calls[0].includes('language=zh'), '应要求中文结果')
    assert.ok(calls[0].includes('count=6'))
    const merged = await searchPlaces('冷湖', { sites: catalog.SITES, provinces: catalog.PROVINCES, cities: catalog.CITIES })
    assert.ok(merged.length >= 1)
  } finally {
    globalThis.fetch = realFetch
    resetGeocodeCache()
  }
  globalThis.fetch = async () => { const error = new Error('abort'); error.name = 'AbortError'; throw error }
  try {
    resetGeocodeCache()
    assert.deepEqual(await remotePlaces('任意', { timeoutMs: 50 }), [])
  } finally {
    globalThis.fetch = realFetch
    resetGeocodeCache()
  }
})

test('瓦片代理：参数校验、缓存命中与失败降级', async () => {
  assert.deepEqual(TILE_STYLES.sort(), ['topo'])
  const bad = await getTile('topo', 2, 0, 0)
  assert.equal(bad.status, 400)
  const street = await getTile('street', 6, 52, 23)
  assert.equal(street.status, 400, '普通底图已移除，应返回 400')
  const badXY = await getTile('topo', 5, 99, 0)
  assert.equal(badXY.status, 400)

  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return { ok: true, headers: new Map([['content-type', 'image/jpeg']]), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }
  }
  try {
    resetTileMemory()
    const first = await getTile('topo', 6, 52, 23)
    assert.equal(first.status, 200)
    assert.ok(first.body.length > 0)
    const before = calls
    const second = await getTile('topo', 6, 52, 23)
    assert.equal(second.status, 200)
    assert.equal(calls, before, '第二次应命中缓存，不再请求上游')
  } finally {
    globalThis.fetch = realFetch
    resetTileMemory()
  }

  globalThis.fetch = async () => { throw new Error('offline') }
  try {
    resetTileMemory()
    const failed = await getTile('topo', 7, 100, 50)
    assert.equal(failed.status, 502)
  } finally {
    globalThis.fetch = realFetch
    resetTileMemory()
  }
})

test('界面：地图只剩地形底图、点站点选中、无搜索/无设为出发地', async () => {
  const { page: buildPage } = await import('../lib/webui.js')
  const page = buildPage()
  for (const keyword of ['地图选点', '__apMap', 'ap-map-pick-label', 'ap-map-title', 'mapModal', 'siteLat', 'onSiteChange', 'onProvinceChange', 'selectSite']) {
    assert.ok(page.includes(keyword), `页面缺少：${keyword}`)
  }
  for (const gone of ['ap-map-q', 'ap-map-style', '把此点设为出发地', 'ap-map-setorigin', 'ap-map-result']) {
    assert.ok(!page.includes(gone), `页面不应再有：${gone}`)
  }
  const client = read('lib/client.js')
  for (const keyword of ['地图选点', '__apMap', 'ap-map-modal', 'customPoint', "qs.set('siteLat'", "result.kind === 'site'", 'ap-map-pick-label']) {
    assert.ok(client.includes(keyword), `Tab 缺少：${keyword}`)
  }
  for (const gone of ['ap-map-q', 'ap-map-style', '把此点设为出发地']) {
    assert.ok(!client.includes(gone), `Tab 不应再有：${gone}`)
  }
})

test('手势：松手才算选点，拖动只平移', () => {
  const src = read('lib/mapview.js')
  assert.ok(src.includes('DRAG_THRESHOLD = 4'), '拖动阈值应为 4px')
  assert.ok(src.includes("addEventListener('pointerdown'"))
  assert.ok(src.includes("addEventListener('pointermove'"))
  assert.ok(src.includes("addEventListener('pointerup'"))
  assert.ok(/if \(dragged\) return/.test(src), '拖动结束时不应选点')
  assert.ok(src.includes('selectAt('), '选点入口存在')
  assert.ok(!/state\.center = \{ lat: point\.lat/.test(src), '选点后不应把视野跳到点击处')
  // 站点选中只在「确定」里回调宿主
  const okBlock = src.slice(src.indexOf("ap-map-ok'").slice)
  assert.ok(okBlock.includes("kind: 'site'"), '确定按钮应处理站点结果')
})

test('自定义点：查询只带坐标，不发 location/province/region', async () => {
  const { page: buildPage } = await import('../lib/webui.js')
  const page = buildPage()
  assert.ok(page.includes('if(!state.custom){'), '页面应在自定义点时跳过三个下拉参数')
  const client = read('lib/client.js')
  assert.ok(client.includes('q.site && !customPoint'), 'Tab 应跳过 location')
  assert.ok(client.includes('q.province && !customPoint'), 'Tab 应跳过 province')
  assert.ok(client.includes('q.region && !customPoint'), 'Tab 应跳过 region')

  // 后端优先级：即使同时传了冲突的 location/region/province，也只出这一个自定义点
  const { search } = await import('../lib/planner.js')
  const result = await search({
    eventType: 'any', siteLat: 38.123, siteLon: 93.456,
    dateStart: '2026-11-16', dateEnd: '2026-11-18', pageSize: 50,
    location: 'haituo', province: '北京', region: '华北',
  })
  const sites = [...new Set(result.ranked.map((item) => item.site.id))]
  assert.deepEqual(sites, ['custom:38.123,93.456'], '结果应只含这个自定义点')
})

test('地图：底部只留经纬度输入，波特尔/名称已移除', async () => {
  const { page: buildPage } = await import('../lib/webui.js')
  const page = buildPage()
  for (const gone of ['ap-map-bortle', 'ap-map-name', '波特尔 <input', '名称 <input']) {
    assert.ok(!page.includes(gone), `地图不应再有：${gone}`)
  }
  assert.ok(page.includes('ap-map-lat') && page.includes('ap-map-lon'), '应有经纬度输入框')
})

test('经纬度解析：小数与角分秒都支持', async () => {
  const { MAP_SRC } = await import('../lib/mapview.js')
  const sandbox = {}
  new Function('window', MAP_SRC)(sandbox)
  const parse = sandbox.__apMap.parseCoord
  assert.equal(parse('39.9042', 'lat'), 39.9042)
  assert.equal(parse('-118.5', 'lon'), -118.5)
  assert.ok(Math.abs(parse('39°54′15.2″N', 'lat') - 39.904222) < 1e-6)
  assert.ok(Math.abs(parse('39 54 15 N', 'lat') - 39.904167) < 1e-6)
  assert.ok(Math.abs(parse('39:54:15', 'lat') - 39.904167) < 1e-6)
  assert.ok(Math.abs(parse('116°24′27″E', 'lon') - 116.4075) < 1e-6)
  assert.equal(parse('39.9 S', 'lat'), -39.9)
  assert.equal(parse('116 W', 'lon'), -116)
  assert.equal(parse('95', 'lat'), null, '纬度超范围应为 null')
  assert.equal(parse('abc', 'lat'), null)
  assert.equal(parse('39°61′00″', 'lat'), null, '分/秒需小于 60')
  assert.equal(sandbox.__apMap.formatCoord(39.9042), '39.904200')
})

test('便签：页面用浮窗渲染，行内不再有 detail', async () => {
  const { page: buildPage } = await import('../lib/webui.js')
  const page = buildPage()
  assert.ok(page.includes('id="noteModal"'), '应有便签浮窗')
  assert.ok(page.includes('ap-note-panel'), '应有面板样式')
  assert.ok(!/class="detail"/.test(page), '行内详情应已移除')
  assert.ok(page.includes('function closeNote()'), '应有关闭入口')
  const client = read('lib/client.js')
  assert.ok(client.includes("className: 'ap-note-modal'"), 'Tab 也应浮窗')
})
