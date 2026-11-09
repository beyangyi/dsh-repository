import assert from 'node:assert/strict'
import test from 'node:test'

import { installApi } from '../lib/api.js'

function fakeCtx() {
  const captured = {}
  return {
    captured,
    webServer: {
      register(route) {
        captured.route = route
        return () => {}
      },
    },
  }
}

function invoke(route, url, method = 'GET') {
  return new Promise((resolve) => {
    const result = { status: 0, body: '', headers: {} }
    const req = { method, url }
    const res = {
      writeHead(status, headers) { result.status = status; result.headers = headers },
      end(body) { result.body = body; resolve(result) },
    }
    route.handler(req, res)
  })
}

test('注册前缀路由 /astro-plan', () => {
  const ctx = fakeCtx()
  installApi(ctx)
  assert.equal(ctx.captured.route.kind, 'prefix')
  assert.equal(ctx.captured.route.path, '/astro-plan')
})

test('GET /astro-plan/api/meta 返回站点与类型', async () => {
  const ctx = fakeCtx()
  installApi(ctx)
  const out = await invoke(ctx.captured.route, '/astro-plan/api/meta')
  assert.equal(out.status, 200)
  const json = JSON.parse(out.body)
  assert.ok(json.ok)
  assert.ok(json.stats.total >= 90)
  assert.ok(json.eventTypes.length >= 10)
  // 画面模拟的静态星表随 meta 一次性下发
  assert.ok(json.sky && json.sky.stars.length > 100, 'meta 应带亮星星表')
  assert.ok(json.sky.lines.length > 40, 'meta 应带星座连线')
  assert.equal(json.sky.ecliptic.length, 72, 'meta 应带黄道')
})

test('GET /astro-plan/api/search 远期日期可返回排序', async () => {
  const ctx = fakeCtx()
  installApi(ctx)
  const out = await invoke(ctx.captured.route,
    '/astro-plan/api/search?eventType=deepsky&location=haituo&dateStart=2027-03-10&dateEnd=2027-03-10&limit=3')
  assert.equal(out.status, 200)
  const json = JSON.parse(out.body)
  assert.ok(json.ok)
  assert.ok(json.ranked.length > 0)
  assert.equal(json.ranked[0].site.id, 'haituo')
})

test('画面模拟：HTTP 查询默认带 sim，?withSim=0 可关', async () => {
  const ctx = fakeCtx()
  installApi(ctx)
  const base = '/astro-plan/api/search?eventType=deepsky&location=haituo&dateStart=2027-03-10&dateEnd=2027-03-10&limit=1'
  const on = JSON.parse((await invoke(ctx.captured.route, base)).body)
  assert.ok(on.ok, on.message)
  assert.ok(on.ranked[0].sim, '页面默认要拿到画面模拟数据')
  assert.ok(on.ranked[0].sim.frames.length >= 5)

  const off = JSON.parse((await invoke(ctx.captured.route, `${base}&withSim=0`)).body)
  assert.equal(off.ranked[0].sim, null, 'withSim=0 时不返回模拟数据')
})

test('GET /astro-plan/api/night 缺参数返回 400', async () => {
  const ctx = fakeCtx()
  installApi(ctx)
  const out = await invoke(ctx.captured.route, '/astro-plan/api/night')
  assert.equal(out.status, 400)
})

test('GET /astro-plan/api/night 正常返回时间轴', async () => {
  const ctx = fakeCtx()
  installApi(ctx)
  const out = await invoke(ctx.captured.route, '/astro-plan/api/night?site=haituo&date=2026-11-13')
  assert.equal(out.status, 200)
  const json = JSON.parse(out.body)
  assert.ok(json.ok)
  assert.equal(json.context.dusk, '18:35')
})

test('GET /astro-plan/ 返回自包含页面', async () => {
  const ctx = fakeCtx()
  installApi(ctx)
  const out = await invoke(ctx.captured.route, '/astro-plan/')
  assert.equal(out.status, 200)
  assert.match(out.headers['content-type'], /text\/html/)
  assert.match(out.body, /星野计划/)
  assert.ok(!/https?:\/\//.test(out.body.replace(/http:\/\/127\.0\.0\.1[^"']*/g, '')), '页面不应依赖外部资源')
})

test('查询区分行 + 查询/重置按钮 + 便签详情', async () => {
  const ctx = fakeCtx()
  installApi(ctx)
  const out = await invoke(ctx.captured.route, '/astro-plan/')
  for (const label of ['时间', '目的地及出发地', '拍摄目标', '开始日期', '结束日期',
    '高度角≥', '波特尔指数（光污染）≤', '目标类型', '查询', '重置', '出发地点',
    '目标地区', '目标省份', '目标地点']) {
    assert.ok(out.body.includes(label), `页面缺少「${label}」`)
  }
  // 旧标签必须已经改掉
  for (const old of ['<label>地区<', '<label>省份<', '<label>具体地点<', '<label>天象类型<', '<label>最低高度角<']) {
    assert.ok(!out.body.includes(old), `仍残留旧标签 ${old}`)
  }
  assert.ok(out.body.includes('目前所在地'), '出发地点应默认「目前所在地」')
  assert.ok(!out.body.includes('>定位<'), '不应再有「定位」按钮')
  assert.ok(!out.body.includes('id="fmt"') && !out.body.includes('id="tracker"'), '拍摄参数筛选条件应已移除')
  assert.ok(!out.body.includes('对日照'), '对日照类型应已移除')
  assert.match(out.body, /推荐度明细与推荐理由/, '推荐度与理由应合并在一个便签区')
  assert.match(out.body, /直线距离/, '地点便签里应合并直线距离')
  assert.ok(out.body.indexOf("kv('直线距离'") < out.body.indexOf("kv('出发地'"), '出发地单独一行放在直线距离之后')
  assert.match(out.body, /max-height:6[0-9]vh/, '便签应限高，避免把下一行挤出屏幕')
  assert.match(out.body, /id="alt"[^>]*value="0"/, '最低高度角默认应为 0')
})

test('表格上方只保留两行小字（页头 1 行 + 统计/提示/备注 1 行）', async () => {
  const ctx = fakeCtx()
  installApi(ctx)
  const out = await invoke(ctx.captured.route, '/astro-plan/')
  const body = out.body.slice(out.body.indexOf('<div class="wrap">'))
  assert.ok(!body.includes('id="origin"'), '出发地点应已并入顶部提示行')
  assert.ok(!body.includes('id="clickhint"'), '「点击行展开详情」应并入统计行')
  assert.ok(!body.includes('id="notes"'), '备注应并入统计行')
  const listAt = body.indexOf('id="list"')
  const statsAt = body.indexOf('id="stats"')
  assert.ok(statsAt > 0 && listAt > statsAt, '统计行应在表格之前')
  const markup = body.slice(0, body.indexOf('<script>'))
  const metaRows = [...markup.matchAll(/class="meta"/g)].length
  assert.equal(metaRows, 1, `正文小字应只剩 1 行（加上页头共 2 行），实际 ${metaRows} 行`)
  const script = out.body.slice(out.body.indexOf('<script>'))
  assert.ok(script.includes('候选 '), '统计行应包含候选数')
  assert.ok(script.includes('结果按推荐度排序，点击行展开详情'), '统计行应包含点击提示')
  assert.ok(script.includes("d.notes.join(' ｜ ')"), '备注应拼进同一行')

  // 页头：标题 + by Sirius YANG + 一行站点/出发地提示
  assert.match(out.body, /<title>星野计划 · by Sirius YANG<\/title>/)
  assert.match(out.body, /<h1>星野计划 <small>by Sirius YANG<\/small><\/h1>/)
  const subs = [...out.body.matchAll(/class="sub"/g)].length
  assert.equal(subs, 1, '页头只应有一行小字')
})

test('查询区文案：拍摄日期 / 单个行星 / 全部深空', async () => {
  const ctx = fakeCtx()
  installApi(ctx)
  const out = await invoke(ctx.captured.route, '/astro-plan/')
  assert.match(out.body, /<div class="plabel">拍摄日期<\/div>/, '「时间」应改为「拍摄日期」')
  assert.ok(!out.body.includes('<div class="plabel">时间</div>'), '不应残留「时间」')
  const meta = JSON.parse((await invoke(ctx.captured.route, '/astro-plan/api/meta')).body)
  const label = (id) => meta.eventTypes.find((t) => t.id === id).label
  assert.equal(label('planet'), '单个行星')
  assert.equal(label('deepsky'), '全部深空')
  // 深空子项在菜单里去掉「深空·」前缀（结果表的「目标类型」列仍带前缀）
  assert.equal(label('deepskyGalaxy'), '星系')
  assert.equal(label('deepskyNebula'), '星云')
  assert.equal(label('deepskyCluster'), '星团')
  assert.equal(label('deepskyPlanetary'), '行星状星云')
  assert.ok(!meta.eventTypes.some((t) => String(t.label).startsWith('深空·')), '菜单里不应再有「深空·」前缀')
  assert.deepEqual(
    meta.eventTypes.filter((t) => t.group === 'planet').map((t) => t.id),
    ['planet', 'opposition', 'elongation', 'conjunction'],
  )
})

test('深色/浅色主题：默认深色变量 + 系统浅色时切浅色', async () => {
  const ctx = fakeCtx()
  installApi(ctx)
  const out = await invoke(ctx.captured.route, '/astro-plan/')
  assert.match(out.body, /:root\{[^}]*--bg:#0b0f17/, '默认应是深色配色')
  assert.match(out.body, /prefers-color-scheme:\s*light/, '应跟随系统浅色')
  const lightBlock = /@media \(prefers-color-scheme: light\)\{[\s\S]*?\n\}/.exec(out.body)
  assert.ok(lightBlock, '缺少浅色主题块')
  assert.match(lightBlock[0], /--bg:#f4f6fb/, '浅色背景变量应被覆盖')
  assert.match(lightBlock[0], /--text:#1d2735/, '浅色文字变量应被覆盖')
  assert.ok(!/background:#101828/.test(out.body), '面板背景应使用变量而不是硬编码')
  assert.ok(!/color:#dbe3f0/.test(out.body), '正文颜色应使用变量而不是硬编码')
})

test('便签：Bortle 复核提示在光污染行，地点区块不再重复', async () => {
  const ctx = fakeCtx()
  installApi(ctx)
  const out = await invoke(ctx.captured.route, '/astro-plan/')
  const placeSec = /<h5>地点<\/h5>[\s\S]*?<\/div>'/.exec(out.body)
  assert.ok(placeSec, '应能找到地点区块')
  assert.ok(!placeSec[0].includes('lightpollutionmap'), '地点区块不应再有 Bortle 复核提示')
  assert.ok(!out.body.includes('Bortle 为估算值'), '页面模板里不应再硬编码这句提示')

  // 检索结果里，提示拼在光污染维度理由的末尾
  const res = await invoke(ctx.captured.route,
    '/astro-plan/api/search?eventType=deepsky&location=haituo&dateStart=2027-03-10&dateEnd=2027-03-10&limit=1')
  const json = JSON.parse(res.body)
  assert.ok(json.ok, json.message)
  const pollution = json.ranked[0].reasonDetail.pollution
  assert.match(pollution, /Bortle 为估算值/)
  assert.match(pollution, /lightpollutionmap\.info/)
  assert.ok(pollution.trim().endsWith('按坐标复核'), '提示应在这行说明的最后')
})

test('便签分区顺序：目标→时间与月相→地点→方位与构图→拍摄参数→天气→推荐度→画面模拟', async () => {
  const ctx = fakeCtx()
  installApi(ctx)
  const out = await invoke(ctx.captured.route, '/astro-plan/')
  const order = ['目标', '时间与月相', '地点', '方位与构图', '拍摄参数', '天气（', '推荐度明细与推荐理由', '画面模拟（最佳时段）']
  const positions = order.map((t) => out.body.indexOf(`<h5>${t}`))
  for (let i = 0; i < order.length; i += 1) {
    assert.ok(positions[i] > 0, `便签缺少分区「${order[i]}」`)
    if (i > 0) assert.ok(positions[i] > positions[i - 1], `分区「${order[i]}」应排在「${order[i - 1]}」之后`)
  }
  // 两列：左 8 个便签，右整列画面模拟
  assert.match(out.body, /class="notegrid"/)
  assert.match(out.body, /class="noteleft"/)
  assert.match(out.body, /class="noteright"/)
  assert.ok(out.body.indexOf('class="noteright"') > out.body.indexOf('class="noteleft"'), '右列应在左列之后')
  assert.ok(out.body.indexOf('class="noteleft"') < positions[0], '左列容器应在第一个便签之前开始')
})

test('目标类型改为两级菜单（页面结构 + 脚本）', async () => {
  const ctx = fakeCtx()
  installApi(ctx)
  const out = await invoke(ctx.captured.route, '/astro-plan/')
  assert.match(out.body, /id="typeBtn"[^>]*class="tbtn"/, '一级入口是一个按钮')
  assert.match(out.body, /id="typeMenu"[^>]*class="tmenu"/, '菜单容器存在')
  assert.match(out.body, /<input id="type" type="hidden" value="any">/, '选中值仍写回隐藏字段')
  assert.ok(!out.body.includes('<select id="type"'), '不再是原生 select')
  assert.match(out.body, /function renderTypeMenu\(\)/, '两列渲染函数存在')
  assert.match(out.body, /function hoverTypeGroup/, '一级悬停切换二级')
  assert.match(out.body, /function pickType/, '二级点击选中')
})

test('启动时不自动检索：boot 不再调用 run', async () => {
  const ctx = fakeCtx()
  installApi(ctx)
  const out = await invoke(ctx.captured.route, '/astro-plan/')
  const script = out.body.slice(out.body.indexOf('<script>'), out.body.lastIndexOf('</script>'))
  const start = script.indexOf('async function boot')
  const boot = script.slice(start, script.indexOf('function provincesOf', start))
  assert.ok(start > 0 && boot.length > 0, '应能找到 boot 函数')
  assert.ok(!/^\s*run\(/m.test(boot), 'boot 里不应直接调用 run()')
  assert.match(boot, /点击「查询」开始检索/, '启动时应显示空状态提示')
})

test('结果列表用网格行渲染：去掉直线距离/天气两列，其余 7 列等宽、最佳时段定宽单行', async () => {
  const ctx = fakeCtx()
  installApi(ctx)
  const out = await invoke(ctx.captured.route, '/astro-plan/')
  assert.match(out.body, /grid-template-columns:repeat\(6,minmax\(0,1fr\)\) 220px minmax\(0,1fr\)/,
    '前六列与最后一列等宽（1fr ×7），最佳时段固定 220px')
  assert.match(out.body, /\.c-window\{white-space:nowrap[,;]/, '最佳时段单元格单行显示')
  assert.match(out.body, /min-width:1040px/, '结果区需要最小宽度，窄屏横向滚动')
  assert.match(out.body, /display:grid/, '行用 grid 布局')
  assert.ok(!out.body.includes('<table'), '不再使用 table，避免宿主 table 样式把单元格挤成一列')
  assert.match(out.body, /flex-wrap:nowrap/, '每个分组的查询要素应保持在同一行')
})

test('分页处提供页码输入框与跳转按钮', async () => {
  const ctx = fakeCtx()
  installApi(ctx)
  const out = await invoke(ctx.captured.route, '/astro-plan/')
  const script = out.body.slice(out.body.indexOf('<script>'))
  assert.ok(script.includes('id="pageInput"'), '缺少页码输入框')
  assert.ok(script.includes('function jumpPage'), '缺少跳转函数')
  assert.match(script, /跳转/, '缺少跳转按钮文案')
})

test('「目标类型」列位于「推荐度」之后、「目标」之前', async () => {
  const ctx = fakeCtx()
  installApi(ctx)
  const out = await invoke(ctx.captured.route, '/astro-plan/')
  const script = out.body.slice(out.body.indexOf('<script>'))
  const heads = /var head = \[([^\]]+)\]/.exec(script)
  assert.ok(heads, '应能找到表头数组')
  const list = heads[1].replace(/['\s]/g, '').split(',')
  assert.deepEqual(list, ['#', '推荐度', '目标类型', '目标', '拍摄地点', '日期', '最佳时段', '最高高度'])
  assert.ok(script.includes("cell('c-type'"), '每行应渲染目标类型单元格')
})

test('结果行渲染出八个独立单元格，不再有距离/天气列', async () => {
  const ctx = fakeCtx()
  installApi(ctx)
  const out = await invoke(ctx.captured.route, '/astro-plan/')
  // 每行 8 个 <div>：rank / score / 目标类型 / 目标 / 地点 / 日期 / 时段 / 高度
  const script = out.body.slice(out.body.indexOf('<script>'))
  for (const marker of ["cell('rank'", "cell('sc'", "cell('c-type'", "cell('c-target'", "cell('c-site'", "cell('c-date'",
    "cell('c-window'", "cell('c-alt'"]) {
    assert.ok(script.includes(marker), `缺少单元格 ${marker}`)
  }
  for (const gone of ["cell('c-dist'", "cell('c-wx'"]) {
    assert.ok(!script.includes(gone), `不应再有单元格 ${gone}`)
  }
  assert.ok(script.includes('id="row'), '行需要 id 供展开详情')
})

test('未知路径返回 404', async () => {
  const ctx = fakeCtx()
  installApi(ctx)
  const out = await invoke(ctx.captured.route, '/astro-plan/api/nope')
  assert.equal(out.status, 404)
})

test('search 带 originLat/originLon 时返回直线距离', async () => {
  const ctx = fakeCtx()
  installApi(ctx)
  const out = await invoke(ctx.captured.route,
    '/astro-plan/api/search?eventType=deepsky&location=haituo&dateStart=2027-03-10&dateEnd=2027-03-10&limit=1&originLat=39.904&originLon=116.407')
  assert.equal(out.status, 200)
  const json = JSON.parse(out.body)
  assert.ok(json.ok)
  assert.ok(Number.isFinite(json.ranked[0].distanceKm))
  assert.ok(json.ranked[0].distanceKm > 60 && json.ranked[0].distanceKm < 140)
})

test('拍摄参数：页面只负责显示规划层给的曝光依据，坐标用经纬度', async () => {
  const ctx = fakeCtx()
  installApi(ctx)
  const out = await invoke(ctx.captured.route, '/astro-plan/')
  assert.match(out.body, /function exposureHint\(p\)\{\s*return p\.hint \|\| '';/, '曝光依据由规划层给出，页面不重复实现公式')
  assert.match(out.body, /function latLonText\(lat, lon\)/, '坐标改用经纬度表述')
  assert.match(out.body, /北纬/, '坐标应带「北纬/南纬」')
  assert.match(out.body, /trackerRequired \? '必须使用'/, '深空/行星类赤道仪标「必须使用」')
})

test('meta 返回三级地点数据（地区/省份/城市/站点）', async () => {
  const ctx = fakeCtx()
  installApi(ctx)
  const out = await invoke(ctx.captured.route, '/astro-plan/api/meta')
  const json = JSON.parse(out.body)
  assert.ok(json.regions.length >= 6)
  assert.ok(json.provinces.every((p) => p.name && p.region))
  assert.ok(json.cities.length > 20)
  assert.ok(json.sites.every((s) => s.region && s.province))
})

test('meta 暴露数据库更新时间，页面第一行小字显示它', async () => {
  const ctx = fakeCtx()
  installApi(ctx)
  const json = JSON.parse((await invoke(ctx.captured.route, '/astro-plan/api/meta')).body)
  assert.ok(json.database, 'meta 应有 database 区块')
  assert.match(json.database.updatedAtText, /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/)
  assert.equal(json.database.refreshDays, 7)
  assert.equal(json.database.cometCount, json.comets.count)

  const out = await invoke(ctx.captured.route, '/astro-plan/')
  assert.match(out.body, /'数据库 '\+dbUpdated\+' 更新 · 站点库 '/,
    '顶部第一行小字应以「数据库 … 更新」开头')
  assert.match(out.body, /var dbUpdated = \(m\.database && m\.database\.updatedAtText\)/, '时间来自 meta.database')
})
