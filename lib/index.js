/**
 * dsh-astro-plan — 宿主入口。
 *
 * 注册一个 `astro_plan` 工具（模型可用）+ 一个 /astro-plan HTTP 面
 * （浏览器页面与查询 API），客户端 Tab 由 lib/client.js 提供。
 *
 * 设计原则：纯插件（只走公开 seam：tools / webServer），零运行时依赖，
 * 星历用 vendored astronomy-engine，天气用 Open-Meteo。
 */

import { search, timeline, meta, EVENT_TYPES } from './planner.js'
import { installApi } from './api.js'
import * as catalog from './catalog.js'
import * as database from './database.js'
import * as events from './events.js'

export const name = 'dsh-astro-plan'

export const inject = ['tools']

const ACTIONS = ['search', 'window', 'meta', 'events', 'params']

/** ISO → 北京时间 "MM-DD HH:MM"。 */
function cst(iso) {
  const d = new Date(new Date(iso).getTime() + 8 * 3600 * 1000)
  return `${d.toISOString().slice(5, 10)} ${d.toISOString().slice(11, 16)}`
}

/** 国内参考站点（用于「北京能否看到」这类提示）。 */
function refSite() {
  return catalog.SITES.find((s) => s.province === '北京') ?? catalog.SITES[0]
}

function distText(x) {
  return x.distanceKm === null || x.distanceKm === undefined ? '—' : `${x.distanceKm} km`
}

function renderSearch(result) {
  if (!result.ok) return `星野计划检索失败：${result.message ?? result.error}`
  const lines = []
  const q = result.query
  const pg = result.pagination
  const pageText = pg && pg.totalPages > 1 ? ` · 第 ${pg.page}/${pg.totalPages} 页（共 ${pg.total} 条）` : (pg ? ` · 共 ${pg.total} 条` : '')
  /** 曝光文案：行星/日月/极光的曝光不是整数秒，数据里已给好文案 */
  const expText = (p) => p.exposureText ?? `${p.exposureSec}s × ${p.frames} 张`
  /** 曝光依据：规划层按题材选公式（500 法则 / Looney 11 / 巴德膜 / 极光 / 赤道仪） */
  const expHint = (p) => p.hint ?? ''
  lines.push(`## 星野计划（${q.dateStart}${q.dateStart === q.dateEnd ? '' : ` ~ ${q.dateEnd}`} · ${q.eventTypeLabel} · ${q.location}${pageText}）`)
  lines.push('')
  lines.push('| # | 推荐度 | 目标 | 站点 | 日期 | 最佳时段 | 高度/方位 | 直线距离 | 焦段(FF/APS-C) | 曝光 |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|')
  for (const x of result.ranked) {
    const row = [
      x.rank,
      `**${x.score}**`,
      x.target.name,
      `${x.site.name}（波特尔 ${x.site.bortle}）`,
      x.date,
      `${x.window.start}–${x.window.end}`,
      `${x.geometry.altMax}° / ${x.geometry.directionAtMax ?? x.geometry.direction}`,
      distText(x),
      `${x.params.ffFocal} / ${x.params.apsFocal}`,
      `${expText(x.params)} ISO${x.params.iso}`,
    ]
    lines.push(`| ${row.join(' | ')} |`)
  }
  lines.push('')
  for (const x of result.ranked) {
    lines.push(`**#${x.rank} ${x.site.name} · ${x.target.name}**（${x.date}）`)
    lines.push(`- ${x.reasons.join('；')}`)
    lines.push(`- 构图：${x.geometry.direction}方向 ${x.geometry.azStart}°→${x.geometry.azEnd}°，${x.foreground.name ? `地景「${x.foreground.name}」` : '无预设地景，建议自选前景'}；${x.target.tips ?? ''}`)
    const hint = expHint(x.params)
    lines.push(`- 参数：${x.params.ffFocal}（APS-C ${x.params.apsFocal}）${x.params.aperture}，${expText(x.params)}，ISO ${x.params.iso}${hint ? `（${hint}）` : ''}`)
    lines.push('')
  }
  if (result.notes?.length) {
    lines.push(`> ${result.notes.join('；')}`)
  }
  return lines.join('\n')
}

function renderTimeline(result) {
  if (!result.ok) return `时间轴不可用：${result.message ?? result.error}`
  const c = result.context
  const lines = [
    `## ${result.site.name}（波特尔 ${result.site.bortle}）· ${result.date}`,
    `日落 ${c.sunset ?? '-'}，天文暮光 ${c.dusk}–${c.dawn}，日出 ${c.sunrise ?? '-'}，月照度 ${c.moonIllum}%（${c.moonPhase}）`,
    '',
    '| 时刻 | 地平线以上（高度/方位） |',
    '|---|---|',
  ]
  for (const h of result.hours) {
    if (h.top.length === 0) continue
    lines.push(`| ${h.time} | ${h.top.map((t) => `${t.name} ${t.alt}° ${t.az}°`).join('；')} |`)
  }
  return lines.join('\n')
}

const tool = () => ({
  name: 'astro_plan',
  description: '星野摄影辅助计划：按天象类型（流星雨/彗星/日食/月食/冲日/大距/合/银河/深空·星系/深空·星云/深空·星团/深空·行星状星云/星轨/黄道光/极光）、'
    + '全国地点（地区→省份→具体站点，也支持城市/坐标/全国）、时间段检索，结合光污染（波特尔指数）、方位、'
    + '月相、天象事件与 7 天内实时天气，给出推荐拍摄目标、地景、相机焦段（全画幅/APS-C）与曝光参数，'
    + '并按推荐度排序。提供查询地经纬度时，会给出到拍摄地的直线距离。'
    + '彗星只推荐视星等 ≤ 9、且距日 ≥ 10°（不会被太阳眩光淹没）的目标；冲日/大距/合/彗星按天体亮度评分，日月食按全食高于偏食评分。'
    + '日期在 7 天内时自动接入 Open-Meteo 逐时天气；更远日期仅按天文条件评估。'
    + '彗星库每周首次启动时自动从 MPC 重建，meta 里给出数据库更新时间。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: ACTIONS,
        description: 'search=按条件检索推荐；window=某站某夜逐小时时间轴；meta=数据概览；events=天象事件；params=某目标的拍摄参数',
      },
      eventType: {
        type: 'string',
        enum: EVENT_TYPES,
        description: '目标类型，默认 any。日食/月食/冲日/大距/合 只在事件当天有结果（事件由星历现算）；彗星只看视星等 ≤ 9 且距日 ≥ 10° 的彗星',
      },
      location: { type: 'string', description: '具体站点名/id、城市、省份、区域、坐标 "lat,lon"，或 全国' },
      region: { type: 'string', description: '地区（华北/东北/西北/西南/华东/华中/华南/港澳台）' },
      province: { type: 'string', description: '省级行政区名，如 青海' },
      dateStart: { type: 'string', description: '开始日期 YYYY-MM-DD（夜的定义：当日 15:00 至次日 09:00）；不得晚于结束日期' },
      dateEnd: { type: 'string', description: '结束日期 YYYY-MM-DD，默认开始日期 +6；与开始日期跨度最长一年（366 天）' },
      minAltitude: { type: 'number', description: '最低高度角（度），默认 0（地平线以上即可参与评估）' },
      maxBortle: { type: 'number', description: '波特尔指数（光污染）上限，1–9，默认 6' },
      format: { type: 'string', enum: ['ff', 'aps-c'], description: '画幅，默认 ff' },
      tracker: { type: 'boolean', description: '是否有星空赤道仪' },
      limit: { type: 'number', description: '每页条数（默认 20，上限 100；也可用 pageSize）' },
      page: { type: 'number', description: '页码，从 1 开始（默认 1）' },
      pageSize: { type: 'number', description: '每页条数，默认 20' },
      siteLimit: { type: 'number', description: '参与评估的站点上限，默认=站点库全部（128）；可调小以加速' },
      targetId: { type: 'string', description: 'action=params 时的目标 id，如 m42 / wintermw / tauN' },
      siteLat: { type: 'number', description: '地图选点纬度（-90~90）：给定后忽略 location，直接以该点作为拍摄地' },
      siteLon: { type: 'number', description: '地图选点经度（-180~180）' },
      siteBortle: { type: 'number', description: '地图选点的波特尔指数（1–9，可选；不给则按邻近站点估算）' },
      siteName: { type: 'string', description: '地图选点的名称（可选）' },
      originLat: { type: 'number', description: '查询者所在地纬度（用于计算到拍摄地的直线距离）' },
      originLon: { type: 'number', description: '查询者所在地经度' },
    },
    required: ['action'],
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        markdown: { type: 'string' },
        ranked: { type: 'array', items: { type: 'object', additionalProperties: true } },
        notes: { type: 'array', items: { type: 'string' } },
        error: { type: 'string' },
      },
      required: ['ok'],
    },
    render: (_args, value) => [{ type: 'text', text: value.markdown ?? '' }],
  },
  async execute(args = {}) {
    const action = ACTIONS.includes(args.action) ? args.action : 'search'
    if (action === 'meta') {
      const m = meta()
      return {
        ok: true,
        markdown: '# 星野计划 · 数据概览\n'
          + `- 数据库更新：${m.database.updatedAtText}（彗星库 ${m.database.cometCount} 颗，每 ${m.database.refreshDays} 天首次启动自动重建）\n`
          + `- 站点 ${m.stats.total} 个，覆盖 ${m.stats.provinces} 个省级行政区，平均波特尔指数 ${m.stats.avgBortle.toFixed(1)}\n`
          + `- 区域分布：${Object.entries(m.stats.byRegion).map(([k, v]) => `${k} ${v}`).join('，')}\n`
          + `- 天象类型：${m.eventTypes.map((t) => `${t.label}(${t.id})`).join('、')}\n`
          + `- 天气覆盖：${m.weather.from} ~ ${m.weather.to}\n`
          + `- 目标库 ${m.targets.length} 个`,
        meta: m,
      }
    }
    if (action === 'window') {
      const siteId = args.location || args.site || ''
      const dateStr = args.dateStart || args.date || ''
      const result = timeline(siteId, dateStr, args)
      return { ok: result.ok, markdown: renderTimeline(result), ...result }
    }
    if (action === 'events') {
      const start = args.dateStart ? new Date(`${args.dateStart}T00:00:00Z`) : new Date()
      const end = args.dateEnd ? new Date(`${args.dateEnd}T23:59:59Z`) : new Date(start.getTime() + 30 * 86400000)
      const list = catalog.eventsBetween(start, end, 1)
      const lunar = events.lunarEclipsesBetween(start, new Date(end.getTime() + 86400000))
      const solar = events.solarEclipsesBetween(start, new Date(end.getTime() + 86400000))
      const planets = events.planetEventsBetween(start, end)
      const site = refSite()
      const lines = ['# 天象事件', '']
      for (const m of list.meteors) lines.push(`- 流星雨 ${m.name}：${cst(m.peakUtc)}（ZHR ${m.zhr}${m.note ? '，' + m.note : ''}）`)
      for (const e of lunar) {
        const circ = events.lunarCircumstances(site, e)
        const visible = circ.visible ? `，${site.name}月球高度 ${circ.altPeak.toFixed(0)}°` : `，${site.name}月球在地平线下`
        lines.push(`- ${e.label}：${cst(e.peakUtc)}${visible}`)
      }
      for (const e of solar) {
        const local = events.localSolarCircumstances(site, e)
        const visible = local.visible
          ? `，${site.name}可见（${local.label}，食分 ${Math.round((local.obscuration ?? 0) * 100)}%，太阳高度 ${local.altPeak.toFixed(0)}°）`
          : `，${site.name}不可见`
        lines.push(`- ${e.label}：${cst(e.peakUtc)}${visible}`)
      }
      for (const p of planets) lines.push(`- ${p.label}：${cst(p.utc)}${p.sepDeg ? `（${p.sepDeg}°）` : ''}`)
      if (lines.length === 2) lines.push('（该时段内无登记事件）')
      return { ok: true, markdown: lines.join('\n'), events: { ...list, lunar, solar, planets } }
    }
    if (action === 'params') {
      const target = catalog.TARGET_BY_ID.get(args.targetId) || catalog.TARGETS.find((t) => t.name.includes(args.targetId ?? ''))
      if (!target) return { ok: false, error: 'no_target', markdown: `未找到目标 ${args.targetId}` }
      const ranges = Array.isArray(target.months[0]) ? target.months : [target.months]
      const monthsText = ranges.map(([a, b]) => (a === b ? `${a} 月` : `${a}–${b} 月`)).join('、')
      const lines = [
        `# ${target.name} 拍摄参数`,
        `- 类型：${target.type}；最佳月份：${monthsText}；最低波特尔指数：${target.minBortle}`,
        `- 全画幅焦段 ${target.focalFF[0]}–${target.focalFF[1]}mm；APS-C ${Math.round(target.focalFF[0] / 1.5)}–${Math.round(target.focalFF[1] / 1.5)}mm`,
        `- 赤道仪：${target.tracker ? '建议使用' : '可不用'}`,
        `- 要点：${target.tips}`,
      ]
      return { ok: true, markdown: lines.join('\n'), target }
    }
    const result = await search(args)
    return { ok: result.ok, markdown: renderSearch(result), ...result }
  },
})

/** 后台周更彗星库：不 await、不抛错，失败沿用旧快照。 */
function triggerDbRefresh(options = {}) {
  try {
    const r = database.refreshIfDue({
      ...options,
      log: (line) => console.log(`[dsh-astro-plan] ${line}`),
    })
    if (!r.started) return
    r.promise.then((res) => {
      if (res.ok && !res.skipped) console.log(`[dsh-astro-plan] 彗星库已更新：${res.count} 颗`)
      else if (!res.ok) console.warn(`[dsh-astro-plan] 彗星库更新失败（沿用旧数据）：${res.message}`)
    })
  } catch (error) {
    console.warn('[dsh-astro-plan] 彗星库更新检查失败：', error?.message ?? error)
  }
}

export function apply(ctx, config = {}) {
  ctx.effect(() => ctx.tools.register(tool()), 'dsh-astro-plan: astro_plan tool')
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => installApi(webCtx), 'dsh-astro-plan: web api')
    // 每周首次启动时在后台重建彗星库（MPC CometEls.txt）。
    // 放在 webServer 就绪之后触发：启动不等网络，纯工具调用场景也不会为此联网。
    if (config.autoUpdate !== false) triggerDbRefresh()
  })
}
