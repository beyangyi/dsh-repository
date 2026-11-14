/**
 * dsh-astro-plan — 规划层：检索 → 可见窗口 → 评分 → 排序。
 *
 * 流程（性能与精度兼顾）：
 *   1. 解析地点/日期/类型，筛站点（区域/省/名称/坐标就近/Bortle）；
 *   2. 逐夜建「夜间网格」：暮光—晨光之间每 30 分钟一格，预存恒星时与日月高度；
 *   3. 逐目标求连续可见窗口（高度 ≥ minAltitude），跳过当季不可见/永远升不高的目标；
 *   4. 天气只取天文评分靠前的若干站点（≤20），拉一次覆盖 8 天的逐时数据；
 *   5. 五维加权评分并排序，缺天气时按比例重归一。
 */

import * as astro from './astro.js'
import * as catalog from './catalog.js'
import * as events from './events.js'
import * as aurora from './aurora.js'
import * as comets from './comets.js'
import * as database from './database.js'
import * as skyview from './skyview.js'
import { nightWeather, dayWeather, weatherAvailable, weatherCoverage, primeWeather, resetWeatherBreaker, weatherSourceName } from './weather.js'

export const EVENT_TYPES = [
  'any', 'meteor', 'comet', 'solarEclipse', 'lunarEclipse', 'planet', 'opposition', 'elongation', 'conjunction',
  'milkyway', 'deepsky', 'deepskyGalaxy', 'deepskyNebula', 'deepskyCluster', 'deepskyPlanetary',
  'startrail', 'zodiacal', 'aurora',
]

const TYPE_LABEL = {
  any: '不限', meteor: '流星雨', comet: '彗星', solarEclipse: '日食', lunarEclipse: '月食',
  planet: '单个行星', opposition: '冲日', elongation: '大距', conjunction: '合', milkyway: '银河',
  deepsky: '全部深空', deepskyGalaxy: '星系', deepskyNebula: '星云',
  deepskyCluster: '星团', deepskyPlanetary: '行星状星云',
  startrail: '星轨', zodiacal: '黄道光', aurora: '极光',
}

/** 必须落在具体事件当夜的类型：没有事件时直接返回 no_event。 */
const EVENT_ONLY = new Set(['solarEclipse', 'lunarEclipse', 'opposition', 'elongation', 'conjunction'])

/** 行星事件：只在事件时刻所属的那一夜出现。 */
const PLANET_EVENT_TYPES = new Set(['opposition', 'elongation', 'conjunction'])

/** 天象类型分组：星野 / 日月 / 行星 / 深空（下拉框按此分组）。 */
export const EVENT_TYPE_GROUPS = [
  { id: 'nightscape', label: '星野', types: ['milkyway', 'meteor', 'comet', 'zodiacal', 'aurora', 'startrail'] },
  { id: 'sunmoon', label: '日月', types: ['solarEclipse', 'lunarEclipse'] },
  // 行星组：单个行星 → 冲日 → 大距 → 合
  { id: 'planet', label: '行星', types: ['planet', 'opposition', 'elongation', 'conjunction'] },
  {
    id: 'deepsky',
    label: '深空',
    types: ['deepsky', 'deepskyGalaxy', 'deepskyNebula', 'deepskyCluster', 'deepskyPlanetary'],
  },
]

const TYPE_GROUP_OF = {}
for (const group of EVENT_TYPE_GROUPS) {
  for (const id of group.types) TYPE_GROUP_OF[id] = group.id
}

/** 深空细分类型 → 目标库里的 subtype。 */
const DEEPSKY_SUBTYPE = {
  deepskyGalaxy: 'galaxy',
  deepskyNebula: 'nebula',
  deepskyCluster: 'cluster',
  deepskyPlanetary: 'planetary',
}

/** subtype → 展示用标签（结果「目标类型」列用细分名，比笼统的「深空」有信息量）。 */
const SUBTYPE_LABEL = {
  galaxy: '深空·星系',
  nebula: '深空·星云',
  cluster: '深空·星团',
  planetary: '深空·行星状星云',
}

/** 目标的展示类型名。 */
function typeLabelOf(target) {
  if (target.type === 'deepsky' && target.subtype && SUBTYPE_LABEL[target.subtype]) {
    return SUBTYPE_LABEL[target.subtype]
  }
  return TYPE_LABEL[target.type]
}

/** 这些类型与光污染基本无关，不做 Bortle 过滤。 */
const BORTLE_BYPASS = new Set(['planet', 'solarEclipse', 'lunarEclipse', 'opposition', 'elongation', 'conjunction'])

/** 行星与深空是「主体优先」的题材：地景不纳入评分（仍然给出地景名称供构图参考）。 */
const NO_FOREGROUND_TYPES = new Set([
  'planet', 'opposition', 'elongation', 'conjunction',
  'deepsky', 'deepskyGalaxy', 'deepskyNebula', 'deepskyCluster', 'deepskyPlanetary',
])

/**
 * 只能用赤道仪参数的题材：深空 + 单个行星 / 冲日 / 大距。
 * 这些目标要么暗弱（深空）、要么焦距极长（行星），短曝多叠给不出可用结果。
 * 合不在此列：合要看两颗天体的角距，焦段够短时不必上赤道仪（见 conjunctionSetup）。
 */
const TRACKER_ONLY_TYPES = new Set(['deepsky', 'planet', 'opposition', 'elongation'])

/** 行星类：赤道仪跟踪 + 视频/连拍叠加（单张毫秒级，靠叠加凑信噪比）。 */
const PLANET_LIKE_TYPES = new Set(['planet', 'opposition', 'elongation'])

/**
 * 加权总分 → 百分制。
 * 缺数据或明确不参与评分的维度会被剔除，剩下的维度按各自权重归一，
 * 所以「只有 3 个维度有分」和「5 个维度都有分」都是 0–100 的可比分数。
 */
function weightedScore(item, weather) {
  const ignored = item.ignored ?? []
  const dims = []
  if (!ignored.includes('sky')) dims.push([WEIGHTS.sky, item.sky])
  if (!ignored.includes('pollution') && item.pol !== null && item.pol !== undefined) {
    dims.push([WEIGHTS.pollution, item.pol])
  }
  if (!ignored.includes('moon') && item.moonScore !== null && item.moonScore !== undefined) {
    dims.push([WEIGHTS.moon, item.moonScore])
  }
  if (!ignored.includes('foreground') && item.fg) dims.push([WEIGHTS.foreground, item.fg.score])
  if (weather !== null && weather !== undefined) dims.push([WEIGHTS.weather, weather])
  const sum = dims.reduce((acc, [w]) => acc + w, 0)
  if (!(sum > 0)) return 0
  return dims.reduce((acc, [w, v]) => acc + w * v, 0) / sum
}

/** 流星雨只在极大值前后 7 天内、且 ZHR ≥ 10 时才作为可拍目标。 */
const METEOR_WINDOW_DAYS = 7
const MIN_METEOR_ZHR = 10

/** 彗星：只收录视星等 ≤ 9 且距日角 ≥ 10°（否则会被太阳眩光吞掉）。 */
const MAX_COMET_MAG = 9
const MIN_COMET_ELONGATION = 10

// 权重：可见性与天象合并为「天象」0.4，光污染 0.1，月相 0.1，天气 0.2，地景 0.2
const WEIGHTS = { sky: 0.4, pollution: 0.1, moon: 0.1, weather: 0.2, foreground: 0.2 }

const DEFAULTS = {
  action: 'search', eventType: 'any', location: '', region: '全国', province: '',
  dateStart: null, dateEnd: null, timeFrom: '18:00', timeTo: '06:00',
  minAltitude: 0, maxBortle: 6, maxDriveHours: 0, format: 'ff', tracker: false,
  limit: 20, siteLimit: 0, page: 1, pageSize: 20,
  // 画面模拟数据默认不算：只有页面（HTTP 查询）需要，工具结果里带上会无谓变大
  withSim: false,
}

function todayLocal() {
  return astro.localDateString(new Date())
}

/** 数据库更新时间 → 页面小字：北京时间 "YYYY-MM-DD HH:mm"（只有日期的旧数据原样显示）。 */
function dbUpdatedText(iso) {
  if (!iso) return '—'
  const s = String(iso)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s : astro.localDateTime(d)
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

export function dateList(startStr, endStr) {
  const out = []
  let cur = startStr
  let guard = 0
  while (cur <= endStr && guard < 380) {
    out.push(cur)
    cur = addDays(cur, 1)
    guard += 1
  }
  return out
}

/** 最长可搜索跨度（天）：一年。 */
export const MAX_RANGE_DAYS = 365

function dayDiff(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000)
}

export function parseOptions(raw = {}) {
  const opts = { ...DEFAULTS, ...raw }
  opts.eventType = EVENT_TYPES.includes(opts.eventType) ? opts.eventType : 'any'

  // 日期范围校验：格式 / 顺序 / 最长一年；不合法时给出可读原因，不做静默交换
  const start = String(opts.dateStart || todayLocal())
  const end = String(opts.dateEnd || addDays(start, 6))
  const iso = /^\d{4}-\d{2}-\d{2}$/
  let rangeError = null
  if (!iso.test(start) || !iso.test(end)) {
    rangeError = '日期格式应为 YYYY-MM-DD'
  } else if (end < start) {
    rangeError = `开始日期（${start}）晚于结束日期（${end}），无法搜索`
  } else {
    const span = dayDiff(start, end) + 1
    if (span > MAX_RANGE_DAYS + 1) {
      rangeError = `查询跨度 ${span} 天，超过上限（最长一年，${MAX_RANGE_DAYS + 1} 天），请缩短日期范围`
    }
  }
  opts.dateStart = start
  opts.dateEnd = end
  opts.rangeError = rangeError

  // 最低高度角默认 0（地平线以上即可参与评估），0 是合法值，不能用 `|| 20` 吞掉
  const rawAlt = Number(opts.minAltitude)
  opts.minAltitude = clamp(Number.isFinite(rawAlt) ? rawAlt : 20, 0, 80)
  opts.maxBortle = clamp(Number(opts.maxBortle) || 6, 1, 9)
  opts.limit = clamp(Number(opts.limit) || 20, 1, 200)
  // 分页：pageSize 优先取 pageSize，其次兼容旧的 limit
  const rawPageSize = raw.pageSize ?? raw.limit
  opts.pageSize = clamp(Number(rawPageSize) || 20, 1, 100)
  opts.page = clamp(Number(opts.page) || 1, 1, 9999)
  // 站点上限：默认=全部站点（覆盖全国最大可用站点），可由 siteLimit 调小
  const allSites = catalog.SITES.length
  opts.siteLimit = clamp(Number(opts.siteLimit) || allSites, 1, allSites)
  opts.format = opts.format === 'aps-c' ? 'aps-c' : 'ff'
  opts.tracker = opts.tracker === true || opts.tracker === 'true'
  opts.withSim = opts.withSim === true || opts.withSim === 'true' || opts.withSim === '1'
  opts.weatherSites = clamp(Number(opts.weatherSites) || 20, 0, 40)
  // 查询者出发地（用于直线距离）：originLat/originLon 或 "lat,lon"
  const oLat = Number(opts.originLat)
  const oLon = Number(opts.originLon)
  if (Number.isFinite(oLat) && Number.isFinite(oLon)) {
    opts.origin = { lat: oLat, lon: oLon }
  } else if (typeof opts.origin === 'string' && /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(opts.origin.trim())) {
    const [la, lo] = opts.origin.split(',').map(Number)
    opts.origin = { lat: la, lon: lo }
  } else {
    opts.origin = null
  }
  return opts
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

function monthOf(dateStr) {
  return Number(dateStr.slice(5, 7))
}

/**
 * 夜间网格：暮光→晨光，30 分钟一格。可用 window 覆盖起止（大距类目标要看民用暮光）。
 * options.full=true 时额外算太阳高度与恒星时（只有 timeline 需要，检索时省掉这笔开销）。
 */
function nightGrid(site, dateStr, nc, window, options = {}) {
  const start = window?.start ?? nc.dusk ?? astro.localDate(dateStr, '18:00')
  const end = window?.end ?? nc.dawn ?? astro.localDate(addDays(dateStr, 1), '06:00')
  const stepMs = 30 * 60000
  const times = []
  for (let t = start.getTime(); t <= end.getTime(); t += stepMs) times.push(new Date(t))
  if (times.length < 2) times.push(new Date(end.getTime()))
  const moon = times.map((t) => astro.bodyAltAz('Moon', astro.makeTime(t), site).alt)
  const grid = { times, moon }
  if (options.full) {
    grid.lst = times.map((t) => astro.lstHours(astro.makeTime(t), site.lon))
    grid.sun = times.map((t) => astro.bodyAltAz('Sun', astro.makeTime(t), site).alt)
  }
  return grid
}

/**
 * 民用暮光网格：太阳高度 -6° 的昏→晨。
 * 水星/金星大距时距日只有 18–47°，天文暗夜（太阳 -18°）里早已落下，
 * 用这个网格才能给出真实的「可看时段」。
 */
function civilTwilightGrid(site, date) {
  const t0 = astro.makeTime(astro.localDate(date, '15:00'))
  const dusk = astro.searchSunAltitude(t0, site, -6, -1)
  if (!dusk) return null
  const dawn = astro.searchSunAltitude(astro.makeTime(dusk), site, -6, +1)
  if (!dawn) return null
  return nightGrid(site, date, { dusk, dawn }, { start: dusk, end: dawn })
}

/** 星表坐标按当夜做岁差改正（J2000 → 当日），缓存到网格上。 */
function equOfDate(target, grid) {
  grid.eqCache = grid.eqCache ?? new Map()
  let hit = grid.eqCache.get(target.id)
  if (!hit) {
    hit = astro.ofDateRADec(target.raH * 15, target.dec, astro.makeTime(grid.times[0]))
    grid.eqCache.set(target.id, hit)
  }
  return hit
}

const D2R = Math.PI / 180
const R2D = 180 / Math.PI
const SIDEREAL_RATE = 1.00273790935

/**
 * 恒星目标的夜间可见区间（解析法，替代逐点采样）。
 *
 * alt(H) = asin(sinφ·sinδ + cosφ·cosδ·cosH)，令 alt = minAlt 解出时角半宽 H0，
 * 得到「可见的恒星时区间」，再与「暮光→晨光」的恒星时区间求交。
 * 长跨度检索（最长一年）时比 30 分钟采样快两个数量级，且起止时刻更精确。
 */
function starNightWindow(target, site, nc, minAltDeg, cache) {
  const key = `${site.id}|${target.id}`
  let eq = cache.get(key)
  if (!eq) {
    eq = astro.ofDateRADec(target.raH * 15, target.dec, astro.makeTime(nc.dusk))
    cache.set(key, eq)
  }
  const phi = site.lat * D2R
  const dec = eq.dec * D2R
  const a0 = minAltDeg * D2R
  const cosH = (Math.sin(a0) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec) || 1e-9)
  if (cosH >= 1) return null // 最高高度都达不到 minAlt
  const h0 = Math.acos(Math.max(-1, Math.min(1, cosH))) * R2D / 15 // 小时，≤12

  const lstD = astro.lstHours(astro.makeTime(nc.dusk), site.lon)
  let lstA = astro.lstHours(astro.makeTime(nc.dawn), site.lon)
  if (lstA <= lstD) lstA += 24
  const raH = ((eq.raDeg / 15) % 24 + 24) % 24

  let best = null
  for (let k = -2; k <= 2; k += 1) {
    const center = raH + 24 * k
    const a = Math.max(center - h0, lstD)
    const b = Math.min(center + h0, lstA)
    if (b > a && (!best || b - a > best.b - best.a)) best = { a, b, center }
  }
  if (!best || best.b - best.a <= 0) return null

  const t0 = nc.dusk.getTime()
  const start = new Date(t0 + ((best.a - lstD) / SIDEREAL_RATE) * 3600000)
  const end = new Date(t0 + ((best.b - lstD) / SIDEREAL_RATE) * 3600000)
  if (!(end > start)) return null

  const toLst = (x) => ((x % 24) + 24) % 24
  const altAzAt = (lst) => astro.altAzFromHA(eq.raDeg, eq.dec, lst, site.lat)
  const pStart = altAzAt(toLst(best.a))
  const pEnd = altAzAt(toLst(best.b))
  const culminates = best.center >= best.a && best.center <= best.b
  let altMax
  let azMax
  if (culminates) {
    const peak = altAzAt(toLst(best.center))
    altMax = peak.alt
    azMax = peak.az
  } else {
    altMax = Math.max(pStart.alt, pEnd.alt)
    azMax = pStart.alt >= pEnd.alt ? pStart.az : pEnd.az
  }

  // 月光只需「窗口首 / 中 / 末」三点
  const mid = new Date((start.getTime() + end.getTime()) / 2)
  const moonAlts = [start, mid, end].map((t) => astro.bodyAltAz('Moon', astro.makeTime(t), site).alt)

  return {
    start,
    end,
    hours: (end.getTime() - start.getTime()) / 3600000,
    altMax,
    azMax,
    azStart: pStart.az,
    azEnd: pEnd.az,
    moonAlts,
  }
}

/** 采样目标高度（行星类，30 分钟网格逐点算）。 */
function altSampler(target, grid, site) {
  const arr = grid.times.map((t) => astro.bodyAltAz(target.body, astro.makeTime(t), site).alt)
  return (i) => arr[i]
}

function azAt(target, grid, site, i) {
  return astro.bodyAltAz(target.body, astro.makeTime(grid.times[i]), site).az
}

/** 连续可见窗口（返回最长的一段，含首尾索引）。 */
function visibleWindow(alts, minAlt) {
  let best = null
  let cur = null
  for (let i = 0; i < alts.length; i += 1) {
    if (alts[i] >= minAlt) {
      if (!cur) cur = { start: i, end: i }
      else cur.end = i
      if (!best || (cur.end - cur.start) > (best.end - best.start)) best = { ...cur }
    } else {
      cur = null
    }
  }
  // 只有一个采样点也算可见（否则时长为 0 会被后面直接丢弃）
  if (best && best.end === best.start) {
    if (best.end + 1 < alts.length) best.end += 1
    else if (best.start > 0) best.start -= 1
  }
  return best
}

function maxAltOf(dec, lat) {
  return 90 - Math.abs(lat - dec)
}

/** 目标是否在该月可拍（星表月份 + 当夜最高高度）。 */
function seasonOk(target, month, site) {
  if (target.body) return true
  // 彗星的位置逐日变化，没有固定赤纬，高度由逐夜网格判断
  if (target.type === 'comet') return true
  if (!catalog.inSeason(target, month)) return false
  return maxAltOf(target.dec, site.lat) >= 10
}

/** 光圈只显示一个 f 值；数据里若还有「（…）」之类说明，这里统一裁掉。 */
function apertureOf(type) {
  const raw = catalog.PARAMS.rules.apertureByType[type] || 'f/2.8'
  const hit = /f\s*\/\s*\d+(?:\.\d+)?/.exec(String(raw))
  return hit ? hit[0].replace(/\s+/g, '') : 'f/2.8'
}

/**
 * 不跟踪时的单张曝光上限：广角（中位焦距 ≤ 35mm）用 500 法则，长焦用更保守的 300 法则。
 * 一支变焦两端的安全曝光并不相同（14mm 能曝 35 s，24mm 只有 21 s），
 * 所以给的是区间而不是一个假精确的值；等效焦距按画幅换算（APS-C 裁切 1.5×）。
 */
function untrackedRule(fMin, fMax, format) {
  const crop = format === 'aps-c' ? 1.5 : 1
  const mid = Math.round((fMin + fMax) / 2)
  const limit = mid <= 35 ? 500 : 300
  const effectiveFocal = Math.round(mid * crop * 10) / 10
  const sec = Math.max(0.5, Math.round((limit / effectiveFocal) * 10) / 10)
  // 长焦端更短、广角端更长
  const lo = Math.max(0.5, Math.round((limit / (fMax * crop)) * 10) / 10)
  const hi = Math.max(0.5, Math.round((limit / (fMin * crop)) * 10) / 10)
  return { limit, effectiveFocal, sec, range: [lo, hi] }
}

/** 光圈字符串 → 数字（f/5.6 → 5.6）。 */
function fNumber(aperture) {
  const m = /f\s*\/\s*(\d+(?:\.\d+)?)/.exec(String(aperture))
  return m ? Number(m[1]) : 2.8
}

/**
 * 亮目标（月面 / 日面 / 极光）的曝光：500 法则只解决「星点拖线」，对满月、日面、
 * 极光这类亮度高或自身在动的目标完全不适用，改用各自的经验基准换算：
 *   t = t_ref × (N / N_ref)² × (ISO_ref / ISO)
 * 月食再按食分压暗：食分 1 时压暗 totalityMagDrop 档（满月 → 全食约 13 档）。
 */
function brightExposure(model, N, isoUsed, obscuration = 0) {
  const b = catalog.PARAMS.rules.bright?.[model]
  if (!b) return null
  const base = b.seconds * (N / b.fNumber) ** 2 * (b.iso / isoUsed)
  const sec = model === 'moon'
    ? base * Math.pow(2, (b.totalityMagDrop ?? 13) * Math.pow(clamp(Number(obscuration) || 0, 0, 1), 1.5))
    : base
  // 4 位有效数字：1/1541 s 这种精度足够，别把浮点尾巴写进结果
  return Number(sec.toPrecision(4))
}

/** 秒数 → 不带单位的可读值：≥1 s 一位小数，<1 s 写成 1/N。 */
function secValue(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '—'
  // 0.5 s 以上按小数写（0.8 s），更短才用 1/N，避免出现「1/1 s」这种别扭写法
  if (sec >= 0.5) return String(Math.round(sec * 10) / 10)
  return `1/${Math.round(1 / sec)}`
}

/** 曝光区间 → "20.8–35.7 s"（同一单位只写一次）。 */
function rangeLabel(min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0) return '—'
  if (max / min < 1.01) return `${secValue(max)} s`
  return `${secValue(min)}–${secValue(max)} s`
}

/** 曝光 → 可读文案：≥1 s 保留一位小数，<1 s 写成 1/N s。 */
function exposureLabel(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '—'
  // 与 secValue 保持一致：0.5 s 以上写小数，更短才写 1/N
  if (sec >= 0.5) return `${Math.round(sec * 10) / 10} s`
  return `1/${Math.round(1 / sec)} s`
}

/**
 * 合：可见时段里两颗的最小角距。
 * 事件峰值（`event.sepDeg`）可能发生在白天或地平线以下，直接拿来算焦段会短到装不下 ——
 * 这里只在「两颗都在地平线上」的时段里找最近的一刻。
 */
function conjunctionVisibleSep(target, item) {
  const objects = (target.event?.objects ?? []).filter(Boolean)
  if (!item || !item.start || !item.end || !item.site || objects.length < 2) return null
  const D = Math.PI / 180
  const rd = (body, t) => {
    const eq = astro.A.Equator(astro.A.Body[body], t, astro.observerOf(item.site), true, true)
    return [eq.ra * 15, eq.dec]
  }
  let best = null
  for (let ms = item.start.getTime(); ms <= item.end.getTime(); ms += 10 * 60000) {
    const t = astro.makeTime(new Date(ms))
    let up = true
    for (const b of objects) {
      if (astro.bodyAltAz(b, t, item.site).alt < 0) { up = false; break }
    }
    if (!up) continue
    const [ra1, dec1] = rd(objects[0], t)
    const [ra2, dec2] = rd(objects[1], t)
    const c = Math.sin(dec1 * D) * Math.sin(dec2 * D)
      + Math.cos(dec1 * D) * Math.cos(dec2 * D) * Math.cos((ra1 - ra2) * D)
    const sep = Math.acos(Math.max(-1, Math.min(1, c))) / D
    if (best == null || sep < best) best = sep
  }
  return best
}

/**
 * 合：两颗天体必须同时入镜，所以焦段由「两者张角 × 构图余量」反推，而不是固定 200–1200mm。
 * 张角 = 角距 + 两侧半径：合月时必须把整个月球（半径约 0.26°）也装进去，
 * 否则长焦下月球会被切掉半个。用画幅短边（全画幅 24mm）反解，保证横竖构图都塞得下：
 *   f = 24 / (2·tan(FOV/2))
 * 焦段长到一定程度（长焦端 ≥ trackerFocal）且没有月球定亮度时，就得上赤道仪。
 */
export function conjunctionSetup(target, opts = {}, item = null) {
  const cfg = catalog.PARAMS.rules.conjunction ?? {}
  const sepEvent = clamp(Number(target.event?.sepDeg) || 3, 0.02, 40)
  // 优先用「实际可见时段」的角距：事件峰值在白天时，两者在夜里可能已经拉开好几度
  const sepVis = item ? conjunctionVisibleSep(target, item) : null
  const sep = clamp(sepVis == null ? sepEvent : sepVis, 0.02, 40)
  const objects = target.event?.objects ?? []
  const moonInvolved = objects.includes('Moon')
  // 月亮视半径约 0.26°（视直径 0.49–0.56°）。取景框以两颗的中点为心，
  // 所以每颗到框心是 sep/2，加上自身半径后两侧对称 —— 画幅短边至少要 sep + 2r
  const moonRadius = cfg.moonRadiusDeg ?? 0.26
  const planetRadius = cfg.planetRadiusDeg ?? 0.03
  const bodyRadius = moonInvolved ? moonRadius : planetRadius
  const extent = sep + 2 * bodyRadius
  const fovNeed = extent * (cfg.fovMargin ?? 1.6)
  const shortSide = cfg.sensorShortSide ?? 24
  const rawMax = shortSide / (2 * Math.tan((fovNeed * Math.PI) / 360))
  // 向下取整到 10mm：宁可短一点，也保证两颗天体（含整轮月亮）都在画面内
  const focalMax = clamp(Math.floor(rawMax / 10) * 10, cfg.minFocal ?? 50, cfg.maxFocal ?? 2000)
  const focalMin = clamp(Math.floor((focalMax * (cfg.zoomRatio ?? 0.55)) / 10) * 10, 24, focalMax)
  return {
    sep,
    extent: Math.round(extent * 100) / 100,
    fovNeed: Math.round(fovNeed * 10) / 10,
    focalFF: [focalMin, focalMax],
    moonInvolved,
    // 长焦端超过阈值又没有月亮定亮度（行星-行星要 5 s 叠 20 张）时，才离不开赤道仪
    trackerRequired: !moonInvolved && focalMax >= (cfg.trackerFocal ?? 400),
  }
}

/** 某焦段在指定画幅「短边」上的视场（度），用于核对两体（含整轮月亮）是否都入镜。 */
export function fieldOfView(focalFF, format = 'ff') {
  const crop = format === 'aps-c' ? 1.5 : 1
  const shortSide = format === 'aps-c' ? 16 : 24
  const f = Math.max(1, focalFF * crop)
  return (2 * Math.atan(shortSide / (2 * f)) * 180) / Math.PI
}

/** 不能套 500 法则的题材：月食走 Looney 11、日食走巴德膜经验值、极光走极光经验值。 */
const BRIGHT_MODELS = { lunarEclipse: 'moon', solarEclipse: 'sun', aurora: 'aurora' }

function paramsFor(target, opts, bortle, item = null) {
  // 合：焦段由两颗天体的角距反推（两体必须同框），并据此决定要不要赤道仪
  const conj = target.type === 'conjunction' ? conjunctionSetup(target, opts, item) : null
  const [fMin, fMax] = conj ? conj.focalFF : target.focalFF
  const focalFF = Math.round((fMin + fMax) / 2)
  const { limit: untrackedLimit, effectiveFocal, sec: untrackedSec, range: untrackedRange } = untrackedRule(fMin, fMax, opts.format)
  const planetLike = PLANET_LIKE_TYPES.has(target.type)
  const brightModel = BRIGHT_MODELS[target.type] ?? null
  const conjRule = catalog.PARAMS.rules.conjunction ?? {}
  // 深空与行星类只能用赤道仪参数；合按焦段判断；其余题材按用户是否勾选赤道仪二选一
  const useTracker = conj
    ? (conj.trackerRequired || opts.tracker === true)
    : (TRACKER_ONLY_TYPES.has(target.type) || opts.tracker === true)
  const frameRule = catalog.PARAMS.rules.frames[target.type] ?? null
  const isoTable = { 1: 1600, 2: 1600, 3: 3200, 4: 3200, 5: 6400, 6: 6400, 7: 6400, 8: 6400, 9: 6400 }
  const planetRule = catalog.PARAMS.rules.planetLike ?? {
    exposureSec: 0.05, frames: 500, iso: 800, exposureText: '1/20 s × 500 帧',
  }
  const aperture = apertureOf(target.type)

  let exposureSec
  let baseExposure = null
  let range = null
  let frames
  let iso
  let note
  let rule
  if (planetLike) {
    // 行星类：赤道仪跟踪 + 视频/连拍叠加，单张极短（1/20 s），靠帧数堆信噪比
    exposureSec = planetRule.exposureSec
    frames = planetRule.frames
    iso = planetRule.iso
    note = '赤道仪跟踪 + 视频叠加'
    rule = 'video'
  } else if (conj && conj.moonInvolved) {
    // 行星合月：画面里最亮的是月亮，曝光按月面（Looney 11）定，行星以亮点同框
    iso = catalog.PARAMS.rules.bright.moon.isoUsed
    baseExposure = brightExposure('moon', fNumber(aperture), iso, 0)
    exposureSec = baseExposure
    range = [baseExposure, baseExposure]
    frames = 1
    note = '月面曝光（Looney 11），行星同框'
    rule = 'moon'
  } else if (conj) {
    // 行星合行星：两体都是亮点，短焦直接拍；长焦必须跟踪
    if (useTracker) {
      exposureSec = conjRule.trackedSeconds ?? 5
      frames = conjRule.trackedFrames ?? 20
      iso = conjRule.iso ?? 800
      note = '赤道仪跟踪 + 叠加（两体同框）'
      rule = 'tracker'
    } else {
      exposureSec = untrackedSec
      range = untrackedRange
      frames = conjRule.untrackedFrames ?? 20
      iso = isoTable[bortle] ?? 3200
      note = '短曝多叠（两体同框）'
      rule = untrackedLimit === 300 ? '300' : '500'
    }
  } else if (brightModel) {
    // 月面 / 日面 / 极光：亮度或运动决定曝光，与星点拖线无关，也不用赤道仪
    const b = catalog.PARAMS.rules.bright[brightModel]
    iso = b.isoUsed
    const n = fNumber(aperture)
    baseExposure = brightExposure(brightModel, n, iso, 0)
    exposureSec = brightExposure(brightModel, n, iso, item?.obscuration ?? 0)
    frames = Math.max(1, frameRule ? frameRule.untracked : 1)
    // 月食：从满月亮度一路压到全食；日面/极光：按 ±1 档给拍摄区间
    range = brightModel === 'moon'
      ? [baseExposure, exposureSec]
      : [baseExposure / 2, baseExposure * 2]
    note = brightModel === 'moon' ? '月面曝光（Looney 11 + 食分压暗）'
      : (brightModel === 'sun' ? '日面曝光（巴德膜 ND5）' : '极光曝光（短曝冻结结构）')
    rule = brightModel
  } else if (useTracker) {
    // 彗星要留住彗尾，单张不宜过长
    exposureSec = target.type === 'deepsky' ? 120 : (target.type === 'comet' ? 90 : 60)
    frames = Math.max(1, frameRule ? frameRule.tracked : 1)
    iso = isoTable[bortle] ?? 3200
    note = '赤道仪单张 + 叠加'
    rule = 'tracker'
  } else {
    exposureSec = untrackedSec
    range = untrackedRange
    frames = Math.max(1, frameRule ? frameRule.untracked : 1)
    iso = isoTable[bortle] ?? 3200
    note = untrackedLimit === 300 ? '短曝多叠（300 法则）' : '短曝多叠（500 法则）'
    rule = untrackedLimit === 300 ? '300' : '500'
  }

  // 曝光统一写成区间（a–b s）+ 张数；单一值时就是 "120 s × 20 张"
  const exposureText = rule === 'video'
    ? planetRule.exposureText
    : range
      ? (frames > 1 ? `${rangeLabel(range[0], range[1])} × ${frames} 张` : rangeLabel(range[0], range[1]))
      : `${exposureSec} s × ${frames} 张`

  // 说明这段曝光是怎么来的（500 法则不再在便签里解释，曝光本身就给了区间）
  const obsc = clamp(Number(item?.obscuration) || 0, 0, 1)
  const conjHint = conj
    ? (conj.moonInvolved
      ? `行星合月：角距 ${conj.sep}° + 月面 0.52° → 需 ${conj.fovNeed}° 视场，${fMin}–${fMax}mm 才能把整轮月球和行星一起装进画面；`
        + `曝光按月球（Looney 11）${exposureLabel(exposureSec)}，行星是亮点，想要行星细节可再曝一张合成；曝光极短，不用赤道仪`
      : conj.trackerRequired
        ? `两体同框：角距 ${conj.sep}° → 需 ${conj.fovNeed}° 视场，${fMin}–${fMax}mm；长焦端 ≥ ${conjRule.trackerFocal ?? 400}mm，短曝只有零点几秒，叠 ${frames} 张必须上赤道仪跟踪`
        : `两体同框：角距 ${conj.sep}° → 需 ${conj.fovNeed}° 视场，${fMin}–${fMax}mm；焦段不长，不用赤道仪也能拍`)
    : null
  const hint = conjHint ?? (rule === 'video'
    ? `行星类只给赤道仪参数：跟踪 + 视频叠加，单张 ${exposureText}，取 10–20% 最优帧`
    : rule === 'tracker'
      ? `赤道仪跟踪：单张 ${exposureSec} s，叠加 ${frames} 张`
      : rule === 'moon'
        ? `月面按 Looney 11（f/11·ISO 100 = 1/100 s）换算：满月 ${exposureLabel(baseExposure)}，`
          + `等效食分 ${Math.round(obsc * 100)}% 再压暗 ${Math.round(13 * Math.pow(obsc, 1.5))} 档 → ${exposureLabel(exposureSec)}`
        : rule === 'sun'
          ? `日面按巴德膜 ND5（f/8·ISO 100 = 1/1000 s）换算：${exposureLabel(exposureSec)}；全食摘膜后 1/1000–2 s 包围曝光`
          : rule === 'aurora'
            ? '极光靠短曝冻结结构（f/2.8·ISO 1600 ≈ 4 s），强 Kp 减半、弱 Kp 加倍'
            : '')

  return {
    ffFocal: `${fMin}–${fMax}mm`,
    ffFocalMid: focalFF,
    apsFocal: `${Math.round(fMin / 1.5)}–${Math.round(fMax / 1.5)}mm`,
    // 只给一个 f 值，不带「原生焦距」之类的说明
    aperture,
    // 代表值（区间中点 / 单值），便于程序比较
    exposureSec,
    // 曝光区间 [最短, 最长]（秒）；单值题材为 null
    exposureRange: range ? { min: range[0], max: range[1] } : null,
    // 可直接显示的文案：a–b s（+ 张数）
    exposureText,
    iso,
    frames,
    trackerNeeded: useTracker || Boolean(target.tracker),
    // 深空 / 行星类没有「无赤道仪」方案；合按「长焦端是否超过阈值」判断
    trackerRequired: conj ? conj.trackerRequired : TRACKER_ONLY_TYPES.has(target.type),
    note,
    // rule: tracker / 500 / video / moon / sun / aurora —— 便签里据此解释曝光怎么来的
    rule,
    // 这条曝光的依据（不同题材用不同公式），页面/工具直接显示；500 法则不给说明
    hint,
    effectiveFocal,
    // 满月基准曝光（月食压暗前），便于核对
    baseExposure,
    // 月食用：参与压暗计算的等效食分（0–1）
    obscuration: brightModel === 'moon' && !conj ? obsc : null,
    // 合：两体角距 / 含月亮时的张角 / 需要的视场 / 是否含月亮（焦段就是按这些算出来的）
    conjunction: conj
      ? {
        sep: conj.sep,
        extent: conj.extent,
        fovNeed: conj.fovNeed,
        moonInvolved: conj.moonInvolved,
        fovAtMax: Math.round(fieldOfView(fMax, opts.format) * 10) / 10,
      }
      : null,
    separation: conj ? conj.sep : null,
    // 不跟随时用的法则：广角 500 / 长焦 300（其余题材为 null）
    untrackedLimit: rule === '500' || rule === '300' ? untrackedLimit : null,
  }
}

/** 每个地景名在站点库中出现的次数：越少见越「不可替代」。 */
const FOREGROUND_COUNTS = (() => {
  const counts = new Map()
  for (const site of catalog.SITES) {
    for (const fg of site.foregrounds ?? []) counts.set(fg.name, (counts.get(fg.name) ?? 0) + 1)
  }
  return counts
})()

/** 地景方位窗口的宽度（度，0–360，处理跨 0° 的情况）。 */
function azimuthWidth(fg) {
  const span = fg.azTo - fg.azFrom
  return ((span % 360) + 360) % 360
}

/** 方位角到地景窗口中心的角距（度，0–180）。 */
function azimuthGap(az, fg) {
  const width = azimuthWidth(fg)
  const center = ((fg.azFrom + width / 2) % 360 + 360) % 360
  const diff = Math.abs(az - center) % 360
  return diff > 180 ? 360 - diff : diff
}

/**
 * 地景匹配：返回「方位吻合度 × 不可替代性」。
 *
 * 不可替代性 = 稀缺度 × 专用度：
 *   - 稀缺度：同一地景名在全国站点库里出现得越少越高（独占机位 > 随处可见的开阔地平线）；
 *   - 专用度：地景的方位窗口越窄越高（窄窗口说明这个机位是「为某个方向量身定做」的）。
 * 因此「独占而且方向高度吻合」的地景得分最高，通用地平线即便方位吻合也拿不到满分。
 */
function foregroundMatch(site, az) {
  const list = site.foregrounds ?? []
  if (list.length === 0) {
    return { score: 30, name: null, match: 0, irreplaceability: 0, sharedBy: 0 }
  }
  let best = null
  for (const fg of list) {
    const width = azimuthWidth(fg)
    const half = width / 2
    const diff = azimuthGap(az, fg)
    // 方位吻合度：窗口内 0.8–1.0（越靠中心越高），出窗口后 75° 内线性衰减到 0
    const match = diff <= half
      ? (half <= 0.5 ? 1 : 1 - 0.2 * (diff / half))
      : Math.max(0, 0.8 - ((diff - half) / 75) * 0.8)

    const sharedBy = FOREGROUND_COUNTS.get(fg.name) ?? 1
    const rarity = 1 / (1 + 0.35 * Math.max(0, sharedBy - 1))
    const dedicated = clamp(1.15 - width / 240, 0.45, 1)
    const irreplaceability = clamp(rarity * dedicated, 0.05, 1)
    const score = 100 * match * (0.55 + 0.45 * irreplaceability)

    if (!best || score > best.score) {
      best = { score, name: fg.name, match, irreplaceability, sharedBy, width }
    }
  }
  return best
}

function moonScoreFor(target, moonAlts, illum) {
  const type = target.type
  if (type === 'solarEclipse' || type === 'lunarEclipse') return 100
  if (type === 'startrail') return 92
  const moonUp = moonAlts.some((a) => a > 5)
  // 行星（含冲日/大距/合）：本身很亮，月光影响小
  if (type === 'planet' || type === 'opposition' || type === 'elongation' || type === 'conjunction') {
    return moonUp ? 80 : 95
  }
  if (type === 'meteor') return moonUp ? Math.max(20, 100 - illum * 0.6) : 100
  // 彗星：亮彗星能扛住月光，暗彗星被月光直接淹没
  if (type === 'comet') {
    if (!moonUp) return 100
    const mag = target.comet?.minMag ?? 8
    return Math.max(20, 100 - illum * (mag <= 5 ? 0.55 : 0.95))
  }
  if (type === 'aurora') return moonUp ? Math.max(30, 100 - illum * 0.5) : 100
  // 深空 / 银河 / 黄道光
  if (!moonUp) return 100
  return Math.max(0, 100 - illum * 1.15)
}

/**
 * 可见性分：可观测时间越长分越高（整夜约 8h 为满分基准）。
 * 例外：星轨不看时长（拍多久都行），只看高度。
 */
function visibilityScore(altMax, hours, minAlt, type) {
  const altPart = clamp((altMax - minAlt) / Math.max(1, 45 - minAlt), 0, 1) * 100
  if (type === 'startrail') return altPart
  const hourPart = clamp(hours / 8, 0, 1) * 100
  return 0.4 * altPart + 0.6 * hourPart
}

/**
 * 光污染分：波特尔指数越低（天空越暗）分越高。
 * B1 = 100、B2 = 90 … B9 = 20，每暗一档 +10 分；与目标所需 Bortle 无关，
 * 目标最低 Bortle 只用于在推荐理由里说明「够不够用」。
 */
function pollutionScore(bortle) {
  return clamp(100 - 10 * (bortle - 1), 0, 100)
}

/** 行星越亮，得分越高：-4.5 等（最亮的金星）→ 1，+8 等（海王星）→ 0。 */
function brightnessFactor(mag) {
  if (mag === null || mag === undefined || !Number.isFinite(mag)) return 0.35
  return clamp((8 - mag) / 12, 0, 1)
}

/**
 * 日月食基础分：先按「全食 / 偏食」分层，再用食分细化。
 * 全食（total/annular）保底 85 分，偏食最高 85 分 —— 因此同等条件下
 * 全食永远高于偏食（这就是「全食评分要高于偏食」的硬约束）。
 */
function eclipseBaseScore(kind, obsc) {
  if (kind === 'total' || kind === 'annular') return 85 + 15 * clamp(obsc, 0, 1)
  return 40 + 45 * clamp(obsc, 0, 1)
}

/**
 * 天象分：
 *   流星雨 → ZHR 越大分越高（ZHR 120 打满），再按距极大天数衰减；
 *   日月食 → 全食 > 偏食，食分越大分越高；
 *   冲日 / 大距 / 合 / 彗星 → 行星或彗星越亮分越高（合还看角距是否够近）。
 * @param {{obscuration?:number, visibleFraction?:number, kind?:string, mag?:number, elong?:number}} [detail]
 */
function eventScore(target, nightDate, eventSet, grid, site, radiantAlt, detail = {}) {
  const day = new Date(`${nightDate}T00:00:00Z`).getTime()
  const within = (iso, pad) => Math.abs(new Date(iso).getTime() - day) <= pad * 86400000

  if (target.type === 'meteor') {
    const match = meteorMatch(target, nightDate, eventSet)
    if (!match) return { score: 0, reason: null }
    const { shower, days } = match
    const alt = radiantAlt ?? 0
    // ZHR 主导（120 打满），距极大每天扣 4 分，避免峰值夜被满分压平
    const score = clamp(30 + shower.zhr * 0.45 + alt * 0.1 - days * 4, 5, 100)
    return {
      score,
      days,
      reason: days <= 1
        ? `${shower.name}极大（ZHR ${shower.zhr}）`
        : `${shower.name}极大前后 ${days} 天（ZHR ${shower.zhr}）`,
    }
  }
  if (target.type === 'solarEclipse' || target.type === 'lunarEclipse') {
    let obsc = clamp(Number(detail.obscuration ?? 0), 0, 1)
    const kind = target.event?.kind ?? detail.kind
    // 半影月食的本影食分为 0，但仍是可拍现象：给一个弱事件当量
    if (kind === 'penumbral' && obsc === 0) obsc = 0.15
    const visible = clamp(Number(detail.visibleFraction ?? 1), 0, 1)
    // 全食/环食保底高于任何偏食，可见比例只做轻微折扣
    const score = clamp(eclipseBaseScore(kind, obsc) * (0.8 + 0.2 * visible), 0, 100)
    return { score, reason: detail.reason ?? target.eventNote ?? null }
  }
  if (target.type === 'comet') {
    const mag = detail.mag
    const elong = detail.elong ?? 0
    if (!(mag <= MAX_COMET_MAG) || elong < MIN_COMET_ELONGATION) return { score: 0, reason: null }
    // 越亮分越高；离太阳越远（距日角越大）也越高
    const bright = clamp((9.5 - mag) / 9.5, 0, 1)
    const awayFromSun = clamp((elong - MIN_COMET_ELONGATION) / 90, 0, 1)
    return {
      score: clamp(35 + 40 * bright + 25 * awayFromSun, 0, 100),
      reason: `${target.name} 视星等 ${mag.toFixed(1)}，距日 ${elong.toFixed(0)}°（越亮、离太阳越远分越高）`,
    }
  }
  if (target.type === 'opposition') {
    const mag = events.apparentMagnitude(target.body, target.event?.utc)
    const bodyCn = events.PLANET_CN[target.body] ?? target.body
    return {
      score: Math.round(55 + 45 * brightnessFactor(mag)),
      reason: mag === null
        ? (target.eventNote ?? null)
        : `${bodyCn}冲日，视星等 ${mag.toFixed(1)}（越亮越高分）`,
    }
  }
  if (target.type === 'elongation') {
    const mag = events.apparentMagnitude(target.body, target.event?.utc)
    const bodyCn = events.PLANET_CN[target.body] ?? target.body
    const elong = Number(target.event?.sepDeg) || 0
    const score = 45 + 30 * brightnessFactor(mag) + 25 * clamp(elong / 45, 0, 1)
    return {
      score: Math.round(score),
      reason: `${bodyCn}大距，距日 ${elong.toFixed(1)}°，视星等 ${mag === null ? '—' : mag.toFixed(1)}`,
    }
  }
  if (target.type === 'conjunction') {
    const objects = target.event?.objects ?? [target.body]
    const mags = objects
      .filter((o) => o !== 'Moon')
      .map((o) => events.apparentMagnitude(o, target.event?.utc))
      .filter((m) => m !== null && Number.isFinite(m))
    const mag = mags.length > 0 ? Math.min(...mags) : null
    const sep = Number(target.event?.sepDeg) || 5
    // 角距越小越容易同框
    const score = 45 + 30 * brightnessFactor(mag) + 25 * clamp((5 - sep) / 5, 0, 1)
    return {
      score: Math.round(score),
      reason: mag === null
        ? (target.eventNote ?? null)
        : `${target.eventNote ?? ''}，亮者视星等 ${mag.toFixed(1)}`,
    }
  }
  if (target.type === 'planet') {
    const hit = eventSet.planets.find((p) => within(p.utc, 2) && p.objects.includes(target.body))
    const mag = events.apparentMagnitude(target.body, target.event?.utc ?? `${nightDate}T16:00:00Z`)
    const score = hit ? 60 + 40 * brightnessFactor(mag) : 45 + 10 * brightnessFactor(mag)
    return { score: Math.round(score), reason: hit ? hit.note : null }
  }
  if (target.type === 'milkyway' || target.type === 'deepsky') {
    const shower = nearestShower(nightDate, eventSet.meteors, 1)
    return shower ? { score: 60, reason: `${shower.shower.name}同夜，可兼顾` } : { score: 50, reason: null }
  }
  return { score: 50, reason: null }
}

/**
 * 由星历现算的事件目标：日食 / 月食 / 冲日 / 大距 / 合（含行星合月）。
 * 目标只在其事件所在的夜（或白天窗口）存在，因此不会出现「没有月食也能查到月食」。
 */
export function eventTargetsFor(opts) {
  const type = opts.eventType
  const from = new Date(`${opts.dateStart}T00:00:00Z`)
  const to = new Date(`${opts.dateEnd}T23:59:59Z`)
  const padFrom = new Date(from.getTime() - 86400000)
  const padTo = new Date(to.getTime() + 86400000)
  const eclipseBase = {
    minBortle: 8,
    focalFF: [200, 800],
    tracker: false,
  }
  if (type === 'lunarEclipse') {
    return events.lunarEclipsesBetween(padFrom, padTo).map((eclipse) => ({
      id: `lunarEclipse-${eclipse.id}`,
      name: eclipse.label,
      type: 'lunarEclipse',
      body: 'Moon',
      sizeDeg: 0.5,
      months: [1, 12],
      fg: '地景同框',
      tips: eclipse.kind === 'penumbral'
        ? '半影月食肉眼几乎不可见，建议长焦记录亮度变化'
        : '全食阶段可拍红月，注意与地景同框',
      event: eclipse,
      eventNote: `${eclipse.label}（峰值 ${astro.localHHMM(new Date(eclipse.peakUtc))}）`,
      ...eclipseBase,
    }))
  }
  if (type === 'solarEclipse') {
    return events.solarEclipsesBetween(padFrom, padTo).map((eclipse) => ({
      id: `solarEclipse-${eclipse.id}`,
      name: eclipse.label,
      type: 'solarEclipse',
      body: 'Sun',
      sizeDeg: 0.5,
      months: [1, 12],
      minBortle: 9,
      fg: '西向/东向开阔地平线',
      tips: '镜头前必须加巴德膜或 ND5 减光，包围曝光，切勿肉眼直视',
      event: eclipse,
      eventNote: `${eclipse.label}（峰值 ${astro.localHHMM(new Date(eclipse.peakUtc))}）`,
      focalFF: [200, 800],
      tracker: false,
    }))
  }
  const planetEvents = events.planetEventsBetween(padFrom, padTo)
  if (type === 'opposition' || type === 'elongation' || type === 'conjunction') {
    const tipsOf = {
      opposition: '冲日前后视直径最大、整夜可见，长焦拍细节',
      elongation: '大距前后离太阳最远、处于最佳观测窗口，晨昏低空长焦拍摄',
      conjunction: '两颗天体同框：焦段按角距算，长焦端要上赤道仪，画面里有月球时按月球曝光',
    }
    const focalOf = { opposition: [300, 2000], elongation: [300, 2000], conjunction: [200, 1200] }
    return planetEvents.filter((e) => e.type === type).map((evt) => ({
      id: `${evt.type}-${evt.id}`,
      name: evt.label,
      type: evt.type,
      body: evt.body,
      sizeDeg: 0.02,
      months: [1, 12],
      minBortle: 7,
      focalFF: focalOf[evt.type] ?? [300, 2000],
      tracker: false,
      fg: evt.type === 'elongation' ? '朝日出的低空 + 地景剪影' : '与地景同框（长焦）',
      tips: tipsOf[evt.type],
      event: evt,
      eventNote: evt.note,
    }))
  }
  return []
}

/**
 * 最近的流星雨：在窗口内返回 {shower, days}，按「夜」比较，峰值按年份平移。
 */
function nearestShower(dateStr, meteors, windowDays) {
  const year = Number(dateStr.slice(0, 4))
  const nightMs = new Date(`${dateStr}T00:00:00Z`).getTime()
  let best = null
  for (const shower of meteors) {
    for (const y of [year - 1, year, year + 1]) {
      const peakNight = nightOfIso(peakInYear(shower, y).toISOString())
      const days = Math.abs((nightMs - new Date(`${peakNight}T00:00:00Z`).getTime()) / 86400000)
      if (days <= windowDays && (!best || days < best.days)) best = { shower, days }
    }
  }
  return best
}

/**
 * 流星雨是否落在「极大值 ±7 天」且 ZHR ≥ 10。
 * 夜为 15:00 起始、次日 09:00 结束，所以先把峰值换算到「所属夜」的日期再比。
 * 极大值按「同一月日 + 时刻」平移到查询年份（流星雨峰值逐年漂移 <1 天，规划足够）。
 * @returns {{shower:object, days:number}|null}
 */
function meteorMatch(target, dateStr, eventSet) {
  const shower = eventSet.meteors.find((m) => m.id === target.id || m.name === target.name)
  if (!shower) return null
  if (Number(shower.zhr) < MIN_METEOR_ZHR) return null
  return nearestShower(dateStr, [shower], METEOR_WINDOW_DAYS)
}

/** 把事件表里的极大值平移到指定年份（保留月日与时角）。 */
function peakInYear(shower, year) {
  const d = new Date(shower.peakUtc)
  return new Date(Date.UTC(year, d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()))
}

/** ISO 时刻 → 它所属「夜」的本地日期（夜 D = D 15:00 → D+1 09:00）。 */
function nightOfIso(iso) {
  const local = new Date(new Date(iso).getTime() + 8 * 3600000) // UTC → UTC+8 的“伪 UTC”
  const shifted = new Date(local.getTime() - 9 * 3600000) // 减 9h：凌晨归到前一晚
  return shifted.toISOString().slice(0, 10)
}

/**
 * 彗星目标：来自 MPC 轨道根数（lib/data/comets.json，2024–2044 年最亮 ≤ 15 等共 100+ 颗）。
 * 只有「有可能亮到检索门槛附近」的彗星才进候选池（minMag ≤ 9+1），
 * 否则每次查询都要为几百颗永远是 13 等的彗星做一遍星历，白白拖慢响应。
 */
function cometTargetsFor() {
  return comets.COMETS
    .filter((comet) => comet.minMag <= MAX_COMET_MAG + 1)
    .map((comet) => ({
      id: `comet-${comet.id}`,
      name: comet.name,
      type: 'comet',
      comet,
      sizeDeg: 0.5,
      months: [1, 12],
      minBortle: 4,
      focalFF: [85, 400],
      tracker: comet.minMag <= 6,
      fg: '开阔低空 + 地景剪影',
      tips: `区间内最亮约 ${comet.minMag} 等（${comet.minMagAt}）；轨道为 MPC 二体近似，出发前请用最新观测复核`,
    }))
}

/**
 * 彗星闸门的「站点无关时刻」：当地 22:00。
 * 同一夜所有站点共用这个时刻 → 每颗彗星每夜只算一次星历（缓存命中）。
 */
function cometCheckInstant(date) {
  return astro.localDate(date, '22:00')
}

/** 目标是否属于查询的天象类型（深空按 subtype 细分）。 */
function matchesType(target, eventType) {
  const sub = DEEPSKY_SUBTYPE[eventType]
  if (sub) return target.type === 'deepsky' && target.subtype === sub
  return target.type === eventType
}

/**
 * 查询区间内「最亮的彗星」（只用于没有候选时的解释文案，
 * 让用户知道是「彗星不够亮」而不是「插件坏了」）。
 */
function bestCometInRange(startStr, endStr) {
  const start = new Date(`${startStr}T00:00:00Z`).getTime()
  const end = new Date(`${endStr}T00:00:00Z`).getTime()
  let best = null
  const pool = comets.COMETS.filter((comet) => comet.minMag <= MAX_COMET_MAG + 3)
  for (const comet of pool) {
    for (let t = start; t <= end; t += 7 * 86400000) {
      const st = comets.cometState(comet, new Date(t + 16 * 3600000))
      if (!st || !Number.isFinite(st.mag) || st.elongation < MIN_COMET_ELONGATION) continue
      if (!best || st.mag < best.mag) {
        best = { name: comet.name, mag: st.mag, at: new Date(t).toISOString().slice(0, 10) }
      }
    }
  }
  return best
}

async function weatherMap(sites, dates, now) {
  const map = new Map()
  const candidates = sites.filter(() => true)
  if (candidates.length === 0) return map
  const needed = dates.filter((d) => weatherAvailable(d, now))
  if (needed.length === 0) return map
  // 先用批量请求把需要的站点一次性预热（最多 BATCH_SIZE 一组），失败即熔断
  await primeWeather(candidates)
  const queue = [...candidates]
  async function worker() {
    while (queue.length > 0) {
      const site = queue.shift()
      const perNight = {}
      for (const d of needed) {
        perNight[d] = await nightWeather(site, d, now)
      }
      map.set(site.id, perNight)
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, candidates.length) }, worker))
  return map
}

/**
 * 主检索。
 * @param {object} raw 查询参数（见 DEFAULTS）
 */
export async function search(raw = {}) {
  resetWeatherBreaker()
  const opts = parseOptions(raw)
  const now = new Date()
  const notes = []
  if (opts.rangeError) {
    return { ok: false, error: 'bad_range', message: opts.rangeError, notes, query: opts }
  }
  const dates = dateList(opts.dateStart, opts.dateEnd)

  const resolved = catalog.resolveLocation(opts.location, { region: opts.region, province: opts.province })
  notes.push(...resolved.notes)
  let sites = resolved.sites
  if (sites.length === 0) {
    return { ok: false, error: 'no_site', message: '没有匹配的站点', notes, query: opts }
  }

  // 极光：高纬站点 + NOAA Kp 预报双重判定，达不到阈值就不出结果
  let auroraCtx = null
  if (opts.eventType === 'aurora') {
    const auroraSites = sites.filter((s) => s.tags.includes('aurora'))
    if (auroraSites.length === 0) {
      const names = catalog.SITES.filter((s) => s.tags.includes('aurora')).map((s) => s.name)
      return {
        ok: false, error: 'no_aurora_site',
        message: `极光只在高纬站点有意义（站点库中：${names.join('、')}），当前范围内没有符合条件的站点`,
        notes, query: opts,
      }
    }
    const forecast = await aurora.kpForecast()
    if (!forecast) {
      return {
        ok: false, error: 'no_kp',
        message: '无法获取 NOAA Kp 预报，无法判断极光是否可见，因此不给出推荐',
        notes, query: opts,
      }
    }
    const kpNight = aurora.kpByNight(forecast)
    const cov = aurora.kpCoverage(forecast)
    const eligible = []
    let maxKp = -1
    for (const s of auroraSites) {
      const need = aurora.requiredKp(aurora.geomagneticLatitude(s.lat, s.lon))
      let best = -1
      for (const d of dates) {
        const kp = kpNight.get(d)
        if (kp !== undefined && kp > best) best = kp
      }
      if (best > maxKp) maxKp = best
      if (best >= need) eligible.push({ ...s, auroraNeedKp: need, auroraMaxKp: best })
    }
    if (eligible.length === 0) {
      return {
        ok: false, error: 'no_visible',
        message: maxKp < 0
          ? `极光需要地磁活动预报，NOAA 仅提供 ${cov.from} ~ ${cov.to} 的 Kp，所选日期不在预报范围内，无法判断是否可见`
          : `所选日期内 Kp 预报最高 ${maxKp.toFixed(1)}，低于极光站点所需阈值（漠河约需 6.8，长白山约需 8.8），国内不可见`,
        notes, query: opts,
      }
    }
    sites = eligible
    auroraCtx = { kpNight }
    notes.push(`极光按 NOAA Kp 预报判定（覆盖 ${cov.from} ~ ${cov.to}）：只有该夜 Kp 达到站点阈值的站点才会出现`)
  }

  const bortleFiltered = BORTLE_BYPASS.has(opts.eventType)
    ? sites
    : sites.filter((s) => s.bortle <= opts.maxBortle)
  if (bortleFiltered.length < sites.length) {
    notes.push(`按 Bortle ≤ ${opts.maxBortle} 过滤掉 ${sites.length - bortleFiltered.length} 个站点`)
  }
  sites = bortleFiltered.length > 0 ? bortleFiltered : sites

  sites.sort((a, b) => a.bortle - b.bortle)
  // 站点 × 夜数过大时按区域均衡抽样，保证「最长一年」的查询也能在可接受时间内返回；
  // 站点上限默认就是整库（全国最大可用站点）
  const MAX_CONTEXTS = 9000
  const rangeCap = Math.max(3, Math.floor(MAX_CONTEXTS / dates.length))
  const effectiveLimit = Math.min(opts.siteLimit, rangeCap)
  if (sites.length > effectiveLimit) {
    const groups = new Map()
    for (const s of sites) {
      if (!groups.has(s.region)) groups.set(s.region, [])
      groups.get(s.region).push(s)
    }
    const keep = []
    let round = 0
    while (keep.length < effectiveLimit && round < 60) {
      for (const list of groups.values()) {
        if (list[round] && keep.length < effectiveLimit) keep.push(list[round])
      }
      round += 1
    }
    sites = keep
    if (effectiveLimit < opts.siteLimit) {
      notes.push(`日期跨度 ${dates.length} 夜，为保证响应速度，已按区域均衡从候选站中抽样评估 ${sites.length} 个站点`)
    } else {
      notes.push(`候选站点较多，已按区域均衡取 ${sites.length} 个评估（siteLimit 可调小）`)
    }
  }

  // 事件目标：日食 / 月食 / 冲日 / 大距 / 合 全部由星历现算，只在其事件所在时段存在
  const eventTargets = eventTargetsFor(opts)
  if (EVENT_ONLY.has(opts.eventType) && eventTargets.length === 0) {
    const label = TYPE_LABEL[opts.eventType]
    let hint = ''
    if (opts.eventType === 'solarEclipse' || opts.eventType === 'lunarEclipse') {
      const next = events.nextEclipseAfter(new Date(`${opts.dateStart}T12:00:00Z`).toISOString())
      if (next) hint = `，下一次日月食：${next.peakUtc.slice(0, 10)} ${next.label}`
    } else {
      const wide = events.planetEventsBetween(
        new Date(`${opts.dateStart}T00:00:00Z`),
        new Date(new Date(`${opts.dateStart}T00:00:00Z`).getTime() + 400 * 86400000),
      ).filter((e) => e.type === opts.eventType)
      if (wide.length > 0) hint = `，下一次${label}：${wide[0].utc.slice(0, 10)} ${wide[0].label}`
    }
    return {
      ok: false, error: 'no_event',
      message: `所选日期内没有${label}${hint}`,
      notes, query: { ...opts, eventTypeLabel: label },
    }
  }

  // 日食是白天事件，走单独的路径（夜间网格里太阳永远在地平线下）
  if (opts.eventType === 'solarEclipse') {
    return searchSolarEclipsePath(opts, sites, eventTargets, notes, now)
  }

  let targets
  if (opts.eventType === 'any') {
    // 日食/月食/极光都需要额外判据（白天食相 / Kp 预报），只能在对应类型下单独查
    targets = [
      ...catalog.TARGETS.filter((t) => t.type !== 'lunarEclipse' && t.type !== 'solarEclipse' && t.type !== 'aurora'),
      ...cometTargetsFor(),
      ...eventTargets.filter((t) => t.type !== 'solarEclipse'),
    ]
    const solarInRange = events.solarEclipsesBetween(
      new Date(`${opts.dateStart}T00:00:00Z`),
      new Date(`${opts.dateEnd}T23:59:59Z`),
    )
    for (const eclipse of solarInRange) {
      notes.push(`${eclipse.label}（${eclipse.peakUtc.slice(0, 10)}）为白天事件，请用「日食」类型单独查询`)
    }
  } else if (EVENT_ONLY.has(opts.eventType)) {
    targets = eventTargets
  } else if (opts.eventType === 'comet') {
    targets = cometTargetsFor()
  } else {
    targets = catalog.TARGETS.filter((t) => matchesType(t, opts.eventType))
  }
  if (targets.length === 0) {
    return { ok: false, error: 'no_target', message: `没有类型为 ${opts.eventType} 的目标`, notes, query: opts }
  }

  // 逐站逐夜：夜上下文（search 只需要暮光与月相，用 fast 模式；网格按需构建）
  const contexts = []
  for (const site of sites) {
    for (const date of dates) {
      const nc = astro.nightContext(site, date, { fast: true })
      if (!nc.dusk || !nc.dawn) continue
      contexts.push({ site, date, nc })
    }
  }
  if (contexts.length === 0) {
    return { ok: false, error: 'no_night', message: '所选日期内没有可用的天文暗夜', notes, query: opts }
  }
  if (contexts.length > 6000) {
    notes.push(`本次评估 ${sites.length} 站 × ${dates.length} 夜（${contexts.length} 个站夜），结果生成可能需要数秒`)
  }

  const eventSet = {
    // 流星雨用全量定义：峰值会平移到查询年份，不能按事件表日期过滤
    meteors: catalog.EVENTS.meteors,
    planets: events.planetEventsBetween(
      new Date(new Date(`${opts.dateStart}T00:00:00Z`).getTime() - 86400000),
      new Date(new Date(`${opts.dateEnd}T23:59:59Z`).getTime() + 86400000),
    ),
  }

  // 第一遍：纯天文评分（无网络）
  const prelim = []
  const eqCache = new Map()
  for (const ctx of contexts) {
    const { site, date, nc } = ctx
    const month = monthOf(date)
    for (const target of targets) {
      if (!seasonOk(target, month, site)) continue
      // 流星雨：只在极大值 ±7 天、且 ZHR ≥ 10 的夜间出现
      const meteor = target.type === 'meteor' ? meteorMatch(target, date, eventSet) : null
      if (target.type === 'meteor' && !meteor) continue
      // 月食只在峰值所在的那一夜
      if (target.type === 'lunarEclipse' && !instantNightMatches(target.event?.peakUtc, date)) continue
      // 冲日 / 大距 / 合 只在事件当天的夜里出现（按事件在北京时间的日历日期归属，
      // 这样「2 月 11 日木星冲日」用 2027-02-11 查得到，也不会在前后夜重复刷）
      if (PLANET_EVENT_TYPES.has(target.type)
        && astro.localDateString(new Date(target.event.utc)) !== date) continue
      // 极光：该夜 Kp 达不到站点阈值就不出结果
      if (target.type === 'aurora') {
        const kp = auroraCtx?.kpNight.get(date)
        if (kp === undefined || kp < (site.auroraNeedKp ?? 99)) continue
      }
      // 黄道光本身就是贴地平的锥形光，20° 的门槛会把它全部滤掉；
      // 大距的水星/金星只在民用暮光里露头，太阳 -18° 时早已落下
      const minAlt = target.type === 'zodiacal'
        ? Math.min(opts.minAltitude, 12)
        : (target.type === 'elongation' ? Math.min(opts.minAltitude, 10) : opts.minAltitude)

      // 几何上界：赤纬固定的目标在给定纬度上的最高高度 = 90 - |lat - dec|；
      // 连上界都够不到 minAlt 的，直接跳过（省掉整段星历计算，结果完全一致）
      if (Number.isFinite(target.dec)) {
        const maxAltPossible = 90 - Math.abs(site.lat - target.dec)
        if (maxAltPossible < minAlt - 0.01) continue
      }

      let start
      let end
      let altMax
      let azMax
      let azStart
      let azEnd
      let moonAlts
      let radiantAlt = null
      let eventDetail = {}
      let cometInfo = null
      let label = null

      if (target.type === 'lunarEclipse') {
        // 月食：窗口直接取「食相时段 ∩ 黑夜」，不受 30 分钟网格限制
        // （半影食可能只有十几分钟，用网格会因两端落在同一格而被误丢）
        const circ = events.lunarCircumstances(site, target.event)
        if (!circ.visible || circ.altPeak < 5) continue
        const nightStart = nc.dusk.getTime()
        const nightEnd = nc.dawn.getTime()
        const wsMs = Math.max(circ.start.getTime(), nightStart)
        const weMs = Math.min(circ.end.getTime(), nightEnd)
        if (weMs <= wsMs) continue
        start = new Date(wsMs)
        end = new Date(weMs)
        const phaseMs = Math.max(1, circ.end.getTime() - circ.start.getTime())
        const visibleFraction = clamp((weMs - wsMs) / phaseMs, 0, 1)
        const altAt = (d) => astro.bodyAltAz('Moon', astro.makeTime(d), site)
        const pStart = altAt(start)
        const pEnd = altAt(end)
        const pPeak = altAt(new Date(target.event.peakUtc))
        // 最高点取「窗口首 / 食甚 / 窗口末」三者中最高的那个，方位也取那一刻
        const top = [pStart, pPeak, pEnd].reduce((a, b) => (b.alt > a.alt ? b : a))
        altMax = top.alt
        azMax = top.az
        azStart = pStart.az
        azEnd = pEnd.az
        moonAlts = [start, new Date((wsMs + weMs) / 2), end].map((d) => altAt(d).alt)
        const obsc = clamp(target.event.obscuration ?? 0, 0, 1)
        const full = visibleFraction > 0.999
        // 只在部分阶段可见 → 标为偏食，并给出食分
        label = full ? events.lunarLabel(target.event) : events.lunarPartialLabel(target.event)
        eventDetail = {
          obscuration: obsc,
          // 曝光用的等效食分：只看得到部分食相时，压暗程度按可见比例折算
          exposureObscuration: obsc * visibleFraction,
          visibleFraction,
          kind: target.event.kind,
          reason: `${label}（食分 ${Math.round(obsc * 100)}%，可见 ${Math.round(visibleFraction * 100)}% 食相）`,
        }
      } else if (target.type === 'comet') {
        // 彗星：先在「当地 22:00」这个站点无关的时刻做亮度/距日闸门 ——
        // 同一颗彗星同一夜只算一次星历，100+ 颗彗星也不会拖慢检索；
        // 通过后再用 30 分钟网格算该站的可见窗口
        const pre = comets.cometState(target.comet, cometCheckInstant(date))
        if (!(pre.mag <= MAX_COMET_MAG) || pre.elongation < MIN_COMET_ELONGATION) continue
        const grid = ctx.grid ?? (ctx.grid = nightGrid(site, date, nc))
        const alts = grid.times.map((t) => comets.cometAltAz(target.comet, astro.makeTime(t), site).alt)
        const win = visibleWindow(alts, minAlt)
        if (!win) continue
        const ws = win.start
        const we = win.end
        altMax = Math.max(...alts)
        start = grid.times[ws]
        end = grid.times[we]
        const topAt = grid.times[alts.indexOf(altMax)]
        azMax = comets.cometAltAz(target.comet, astro.makeTime(topAt), site).az
        azStart = comets.cometAltAz(target.comet, astro.makeTime(start), site).az
        azEnd = comets.cometAltAz(target.comet, astro.makeTime(end), site).az
        moonAlts = grid.moon.slice(ws, we + 1)
        const st = comets.cometState(target.comet, grid.times[Math.floor((ws + we) / 2)])
        // 严格闸门：按实际可见窗口的中间时刻再核一次亮度与距日角
        if (!(st.mag <= MAX_COMET_MAG) || st.elongation < MIN_COMET_ELONGATION) continue
        cometInfo = { mag: st.mag, elongation: st.elongation, delta: st.delta, r: st.r }
        eventDetail = { mag: st.mag, elong: st.elongation }
        label = `${target.name}（${st.mag.toFixed(1)} 等）`
      } else if (target.body) {
        // 其他天体（太阳/月亮/行星）：30 分钟采样
        // 大距目标贴着太阳，只能趁民用暮光看：网格改用太阳 -6° 的时段
        let grid
        if (target.type === 'elongation') {
          grid = ctx.civilGrid ?? (ctx.civilGrid = civilTwilightGrid(site, date))
          if (!grid) continue
        } else {
          grid = ctx.grid ?? (ctx.grid = nightGrid(site, date, nc))
        }
        const sample = altSampler(target, grid, site)
        const alts = grid.times.map((_, i) => sample(i))
        const win = visibleWindow(alts, minAlt)
        if (!win) continue
        const ws = win.start
        const we = win.end
        altMax = Math.max(...alts)
        start = grid.times[ws]
        end = grid.times[we]
        azMax = azAt(target, grid, site, alts.indexOf(altMax))
        azStart = azAt(target, grid, site, ws)
        azEnd = azAt(target, grid, site, we)
        moonAlts = grid.moon.slice(ws, we + 1)
        const midIdx = Math.floor((ws + we) / 2)
        if (target.type === 'meteor') radiantAlt = alts[midIdx]
      } else {
        // 恒星目标：解析法求可见区间（时角），不再逐点采样
        const star = starNightWindow(target, site, nc, minAlt, eqCache)
        if (!star) continue
        start = star.start
        end = star.end
        altMax = star.altMax
        azMax = star.azMax
        azStart = star.azStart
        azEnd = star.azEnd
        moonAlts = star.moonAlts
        if (target.type === 'meteor') radiantAlt = altMax
      }

      const hours = (end.getTime() - start.getTime()) / 3600000
      if (hours <= 0) continue
      const az = (azStart + azEnd) / 2
      // 不参与评分的维度：
      //   月食本身就是月亮 → 月相无意义；
      //   行星（单个/冲日/大距/合）与深空是「主体优先」的题材 → 地景不纳入评分
      const ignored = []
      if (target.type === 'lunarEclipse') ignored.push('moon')
      if (NO_FOREGROUND_TYPES.has(target.type)) ignored.push('foreground')
      const moonScore = ignored.includes('moon') ? null : moonScoreFor(target, moonAlts, nc.moonIllum)
      const fg = foregroundMatch(site, az)
      const evt = eventScore(target, date, eventSet, null, site, radiantAlt, eventDetail)
      const vis = visibilityScore(altMax, hours, minAlt, target.type)
      const pol = pollutionScore(site.bortle)
      const sky = 0.5 * vis + 0.5 * evt.score
      const item = {
        site, date, nc, target, label,
        altMax, azMax, hours, azStart, azEnd, start, end,
        moonScore, vis, pol, fg, evt, sky, cometInfo, ignored,
        // 月食：本站可见的等效食分（0–1），曝光按它压暗；其他题材为 null
        obscuration: eventDetail.exposureObscuration ?? null,
      }
      // 缺维度时按实际参与的权重归一到 100 分（而不是把缺的当 0 分）
      item.astroScore = weightedScore(item)
      prelim.push(item)
    }
  }

  if (prelim.length === 0) {
    let message
    if (opts.eventType === 'meteor') {
      message = '所选日期不在任何 ZHR ≥ 10 的流星雨「极大值 ±7 天」内，因此没有流星雨结果'
    } else if (opts.eventType === 'comet') {
      const best = bestCometInRange(opts.dateStart, opts.dateEnd)
      message = `所选日期内没有视星等 ≤ ${MAX_COMET_MAG} 且距日 ≥ ${MIN_COMET_ELONGATION}° 的彗星`
        + (best ? `；区间内最亮的是 ${best.name}（约 ${best.mag.toFixed(1)} 等，${best.at}）` : '')
    } else {
      message = '所选条件下没有可见目标，试试放宽 minAltitude / maxBortle 或扩大日期范围'
    }
    return { ok: false, error: 'no_visible', message, notes, query: opts }
  }

  // 第二遍：给「天文评分靠前 + 各区域代表」的站点补天气
  prelim.sort((a, b) => b.astroScore - a.astroScore)
  const picked = new Set()
  for (const item of prelim) {
    if (picked.size >= opts.weatherSites) break
    picked.add(item.site.id)
  }
  // 各区域再补 2 个代表，避免结果被青藏高原包场
  const perRegion = {}
  for (const item of prelim) {
    const key = item.site.region
    perRegion[key] = perRegion[key] || []
    if (perRegion[key].length < 2 && !picked.has(item.site.id)) {
      perRegion[key].push(item.site.id)
      picked.add(item.site.id)
    }
  }
  const weatherSites = sites.filter((s) => picked.has(s.id))
  const wmap = await weatherMap(weatherSites, dates, now)
  if (wmap.size === 0) {
    notes.push('未取到天气数据，已按纯天文条件排序')
  } else {
    const cov = weatherCoverage(now)
    const sourceName = weatherSourceName() ?? '多源'
    notes.push(`天气：${sourceName} 逐时预报，覆盖 ${cov.from} ~ ${cov.to}；仅对天文评分靠前的 ${weatherSites.length} 站取天气（模式预报，出发前 6 小时请复查）`)
  }

  const ranked = []
  let weatherFailed = false
  for (const item of prelim) {
    const wx = wmap.get(item.site.id)?.[item.date]
      ?? { status: weatherAvailable(item.date, now) ? 'unavailable' : 'out_of_range', score: null }
    if (wx.status === 'unavailable') weatherFailed = true
    // 天气只是 0.2 权重的加分项：取不到就按纯天文维度归一，绝不因此把整天的结果丢掉
    const score = (wx.score === null || wx.score === undefined)
      ? item.astroScore
      : weightedScore(item, wx.score)
    ranked.push({ ...item, weather: wx, score })
  }
  if (weatherFailed) {
    notes.push('天气数据暂不可用（服务超时或网络受限），本轮按纯天文条件排序；稍后重试可能恢复')
  }

  // 排序：
  //   流星雨查询 → 先按 ZHR 从大到小，再按「离极大最近」的夜晚，最后按总分（站点质量）
  //   其他类型   → 按总分，同分时流星雨按极大夜/ZHR
  const zhrOf = (item) => {
    if (item.target.type !== 'meteor') return 0
    const m = catalog.EVENTS.meteors.find((x) => x.id === item.target.id || x.name === item.target.name)
    return m ? Number(m.zhr) || 0 : 0
  }
  if (opts.eventType === 'meteor') {
    ranked.sort((a, b) => (zhrOf(b) - zhrOf(a))
      || ((a.evt.days ?? 99) - (b.evt.days ?? 99))
      || (b.score - a.score))
  } else {
    ranked.sort((a, b) => (b.score - a.score)
      || ((a.evt.days ?? 99) - (b.evt.days ?? 99))
      || (zhrOf(b) - zhrOf(a)))
  }
  // 去重规则（保证「地点多样」而不是同一站刷屏）：
  //   1. 同一站 × 同一目标只保留得分最高的那一条（同一场流星雨的多个夜晚不重复占位）；
  //   2. 指定天象类型时不做目标配额，一次列出该类型的最佳若干站点；
  //      「不限」时每个目标最多 3 条，避免被一场流星雨包场。
  const perTargetCap = opts.eventType === 'any' ? 3 : Infinity
  const perTarget = {}
  const seenSiteTarget = new Set()
  const allItems = []
  for (const item of ranked) {
    const siteTarget = `${item.target.id}|${item.site.id}`
    if (seenSiteTarget.has(siteTarget)) continue
    const key = item.target.id
    if ((perTarget[key] || 0) >= perTargetCap) continue
    perTarget[key] = (perTarget[key] || 0) + 1
    seenSiteTarget.add(siteTarget)
    allItems.push(item)
  }
  const page = paginate(allItems, opts)
  const top = page.items.map((item) => shapeRanked(item, item._rank, opts))

  return {
    ok: true,
    query: {
      action: opts.action, eventType: opts.eventType, eventTypeLabel: TYPE_LABEL[opts.eventType],
      location: opts.location || '全国', region: opts.region, dateStart: opts.dateStart,
      dateEnd: opts.dateEnd, timeFrom: opts.timeFrom, timeTo: opts.timeTo,
      minAltitude: opts.minAltitude, maxBortle: opts.maxBortle, format: opts.format,
      tracker: opts.tracker, limit: opts.limit, siteLimit: opts.siteLimit, origin: opts.origin,
      page: page.page, pageSize: opts.pageSize,
    },
    ranked: top,
    pagination: { total: page.total, page: page.page, pageSize: opts.pageSize, totalPages: page.totalPages },
    poolSize: { sites: sites.length, contexts: contexts.length, candidates: prelim.length },
    notes,
    generatedAt: new Date().toISOString(),
  }
}

/**
 * 分页：把完整结果按 20/页切片，rank 编号跨页连续。
 * 返回 items 上带 _rank（1 基全局序号）。
 */
function paginate(list, opts) {
  const total = list.length
  const totalPages = Math.max(1, Math.ceil(total / opts.pageSize))
  const page = Math.min(Math.max(1, opts.page), totalPages)
  const start = (page - 1) * opts.pageSize
  const items = list.slice(start, start + opts.pageSize).map((item, i) => ({ ...item, _rank: start + i + 1 }))
  return { items, total, page, totalPages }
}

/** 事件时刻是否落在「第 dateStr 夜」（D 15:00 → D+1 09:00）。 */
function instantNightMatches(iso, dateStr) {
  if (!iso) return false
  const peak = new Date(iso).getTime()
  const start = astro.localDate(dateStr, '15:00').getTime()
  const end = astro.localDate(addDays(dateStr, 1), '09:00').getTime()
  return peak >= start && peak < end
}

/**
 * 日食专用检索路径：白天事件，不使用夜间网格。
 * 逐站点算本地食相（可见性 / 食分 / 初亏复圆 / 太阳高度），再按
 * 天象（含食分与全食/偏食分层）0.4 + 天气 0.2 + 地景 0.2 排序。
 * 光污染与月相对日食没有意义，已从评分中剔除。
 */
async function searchSolarEclipsePath(opts, sites, eventTargets, notes, now) {
  const candidates = []
  for (const target of eventTargets) {
    for (const site of sites) {
      const circ = events.localSolarCircumstances(site, target.event)
      if (!circ.visible || circ.altPeak < 3) continue
      const date = astro.localDateString(circ.peak)
      if (date < opts.dateStart || date > opts.dateEnd) continue
      candidates.push({ site, target, circ, date })
    }
  }
  const names = eventTargets.map((t) => t.name).join('、')
  if (candidates.length === 0) {
    return {
      ok: false,
      error: 'no_visible',
      message: `${names}在该日期范围内的中国站点均不可见（峰值时太阳在地平线以下，或站点不在偏食带内）`,
      notes,
      query: { ...opts, eventTypeLabel: TYPE_LABEL.solarEclipse },
    }
  }

  candidates.sort((a, b) => (b.circ.obscuration ?? 0) - (a.circ.obscuration ?? 0))
  const wmap = new Map()
  const queue = candidates.slice(0, Math.min(candidates.length, opts.weatherSites))
  async function worker() {
    while (queue.length > 0) {
      const it = queue.shift()
      if (!weatherAvailable(it.date, now)) continue
      const w = await dayWeather(it.site, it.date, astro.localHHMM(it.circ.begin), astro.localHHMM(it.circ.end))
      wmap.set(`${it.site.id}|${it.date}`, w)
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker))
  if (wmap.size > 0) {
    const cov = weatherCoverage(now)
    notes.push(`日食天气：按当地食甚时段取云量，覆盖 ${cov.from} ~ ${cov.to}（模式预报，出发前 6 小时请复查）`)
  }
  notes.push('观测日食必须使用巴德膜/ND5 减光，肉眼或未加滤镜的镜头直视会造成永久损伤')

  const items = []
  for (const it of candidates) {
    const w = wmap.get(`${it.site.id}|${it.date}`) ?? { status: 'out_of_range', score: null }
    // 同上：只有该日期本来就能取到天气预报时才要求站点有天气
    if (weatherAvailable(it.date, now) && (w.score === null || w.score === undefined)) continue
    const obsc = Math.max(0, Math.min(1, it.circ.obscuration ?? 0))
    const altScore = clamp((it.circ.altPeak - 3) / 40, 0, 1) * 100
    const peakPos = astro.bodyAltAz('Sun', astro.makeTime(it.circ.peak), it.site)
    const fg = foregroundMatch(it.site, peakPos.az)
    const wScore = w.score === null || w.score === undefined ? null : w.score
    // 日食评分不含光污染与月相（白天的食相与这两项无关）：
    // 天象 0.4 + 天气 0.2 + 地景 0.2，按实际参与的权重换算成 100 分制
    const evtScore = eclipseBaseScore(it.circ.kind, obsc)
    const sky = 0.5 * altScore + 0.5 * evtScore
    const illum = astro.moonIllumPercent(astro.makeTime(it.circ.peak))
    // 不在全（环）食带内 → 叫「日偏食」，并标明食分
    const label = it.circ.kind === 'partial'
      ? `日偏食（食分 ${Math.round(obsc * 100)}%）`
      : `${it.circ.label}（食分 ${Math.round(obsc * 100)}%）`
    const entry = {
      site: it.site,
      target: it.target,
      label,
      date: it.date,
      nc: { moonIllum: illum, moonPhase: astro.moonPhaseName(illum, true) },
      altMax: it.circ.altPeak,
      hours: Math.max(0.1, (it.circ.end.getTime() - it.circ.begin.getTime()) / 3600000),
      azStart: astro.bodyAltAz('Sun', astro.makeTime(it.circ.begin), it.site).az,
      azEnd: astro.bodyAltAz('Sun', astro.makeTime(it.circ.end), it.site).az,
      start: it.circ.begin,
      end: it.circ.end,
      // 光污染/月相已从日食评分中移除，分数栏显示为「不参与」而不是假的 100 分
      moonScore: null,
      vis: altScore,
      pol: null,
      ignored: ['pollution', 'moon'],
      fg,
      evt: { score: evtScore, reason: `${label}，太阳高度 ${it.circ.altPeak.toFixed(0)}°` },
      sky,
      weather: w,
    }
    entry.score = weightedScore(entry, wScore)
    items.push(entry)
  }

  if (items.length === 0) {
    return {
      ok: false, error: 'no_visible',
      message: `${names}在该范围内的站点均不可见（或天气数据缺失且无法评估）`,
      notes, query: { ...opts, eventTypeLabel: TYPE_LABEL.solarEclipse },
    }
  }

  items.sort((a, b) => b.score - a.score)
  const page = paginate(items, opts)
  const top = page.items.map((item) => shapeRanked(item, item._rank, opts))
  return {
    ok: true,
    query: {
      action: opts.action, eventType: opts.eventType, eventTypeLabel: TYPE_LABEL.solarEclipse,
      location: opts.location || '全国', region: opts.region, dateStart: opts.dateStart,
      dateEnd: opts.dateEnd, timeFrom: opts.timeFrom, timeTo: opts.timeTo,
      minAltitude: opts.minAltitude, maxBortle: opts.maxBortle, format: opts.format,
      tracker: opts.tracker, limit: opts.limit, siteLimit: opts.siteLimit, origin: opts.origin,
      page: page.page, pageSize: opts.pageSize,
    },
    ranked: top,
    pagination: { total: page.total, page: page.page, pageSize: opts.pageSize, totalPages: page.totalPages },
    poolSize: { sites: sites.length, contexts: candidates.length, candidates: items.length },
    notes,
    generatedAt: new Date().toISOString(),
  }
}

function shapeRanked(item, rank, opts) {
  const { site, target, date, nc } = item
  const params = paramsFor(target, opts, site.bortle, item)
  // 画面模拟（只有页面需要）：任何异常都不能影响检索本身
  let sim = null
  if (opts.withSim) {
    try {
      sim = skyview.buildSim({ item, target, site, params })
    } catch {
      sim = null
    }
  }
  const distanceKm = opts.origin
    ? Math.round(catalog.distanceKm(opts.origin.lat, opts.origin.lon, site.lat, site.lon))
    : null
  // 直线距离 → 车程估算（山区/景区道路通常为直线的 1.2–1.6 倍）
  const driveKm = distanceKm === null
    ? null
    : { min: Math.round(distanceKm * 1.2), max: Math.round(distanceKm * 1.6) }
  const direction = astro.azName((item.azStart + item.azEnd) / 2)
  const needBortle = target.minBortle ?? 4
  // 可见窗口 / 最佳时段都要带日期（夜跨零点，起止可能不在同一天）
  const startAt = astro.localDateTime(item.start)
  const endAt = astro.localDateTime(item.end)
  const visText = `${startAt} – ${endAt} 可见 ${item.hours.toFixed(1)}h，最高 ${item.altMax.toFixed(0)}°（${direction}方向）`
  const evtText = item.evt.reason || '当夜无特别天象（基础分）'
  const ignored = item.ignored ?? []
  // 地景：说清「方位吻合度」和「不可替代性」两件事
  const fgIrre = item.fg.irreplaceability ?? 0
  const fgLevel = fgIrre >= 0.7 ? '高' : (fgIrre >= 0.4 ? '中' : '低')
  const fgText = item.fg.name
    ? `地景「${item.fg.name}」方位吻合 ${Math.round((item.fg.match ?? 0) * 100)}%，`
      + `全国 ${item.fg.sharedBy ?? 1} 站可拍，不可替代性${fgLevel}`
    : '无预设地景，需自选前景（不可替代性低）'
  // 光污染行的说明最后带上 Bortle 复核提示（原来在「地点」里，现在统一收到这里）
  const pollutionText = (ignored.includes('pollution')
    ? '日食为白天事件，光污染不参与评分'
    : `站点波特尔 B${site.bortle}（B1 最暗 = 100 分，越低越好）`
      + (site.bortle <= needBortle ? '，满足' : '，比目标最低要求亮')
      + ` B${needBortle}`)
    + '；Bortle 为估算值，出发前建议在 lightpollutionmap.info 按坐标复核'
  const reasonDetail = {
    // 可见性与天象已合并为「天象」维度：左边给分，右边给两段理由
    sky: `${visText}；${evtText}`,
    pollution: pollutionText,
    moon: ignored.includes('moon')
      ? (target.type === 'lunarEclipse' ? '月食本身就是月球，月光不参与评分' : '日食为白天事件，月相不参与评分')
      : (nc.moonIllum < 5
        ? `无月（照度 ${nc.moonIllum.toFixed(1)}%）`
        : `月照度 ${nc.moonIllum.toFixed(1)}%（${nc.moonPhase}）`),
    weather: item.weather.status === 'ok'
      ? `云 ${item.weather.cloudMean}%，降水 ${item.weather.precipMax}%，最低温 ${item.weather.tMin}℃，风 ${item.weather.windMax} km/h`
      : (item.weather.status === 'out_of_range' ? '超出 7 天天气范围，仅按天文条件评估' : '天气数据不可用'),
    foreground: ignored.includes('foreground')
      ? `行星/深空以目标主体为主，地景不参与评分${item.fg.name ? `（机位地景：${item.fg.name}）` : ''}`
      : fgText,
  }
  const reasons = []
  reasons.push(visText)
  if (!ignored.includes('moon')) reasons.push(reasonDetail.moon)
  if (item.evt.reason) reasons.push(item.evt.reason)
  if (item.fg.name && !ignored.includes('foreground')) reasons.push(`${fgText}（得分 ${Math.round(item.fg.score)}）`)
  if (item.weather.status === 'ok') {
    reasons.push(`天气 ${item.weather.score} 分（云 ${item.weather.cloudMean}%，降水 ${item.weather.precipMax}%，最低温 ${item.weather.tMin}℃）`)
  } else if (item.weather.status === 'out_of_range') {
    reasons.push('超出 7 天天气范围，仅按天文条件评估')
  } else {
    reasons.push('天气数据不可用')
  }
  // 参与评分的维度数：缺数据/不参与时，总分已按剩余权重换算成满分 100 分
  const dimScores = [
    !ignored.includes('sky') ? item.sky : null,
    !ignored.includes('pollution') && item.pol !== null && item.pol !== undefined ? item.pol : null,
    !ignored.includes('moon') && item.moonScore !== null && item.moonScore !== undefined ? item.moonScore : null,
    !ignored.includes('foreground') && item.fg ? item.fg.score : null,
    item.weather.score === null || item.weather.score === undefined ? null : item.weather.score,
  ].filter((v) => v !== null)
  const breakdown = {
    sky: Math.round(item.sky),
    pollution: item.pol === null || item.pol === undefined ? null : Math.round(item.pol),
    moon: item.moonScore === null || item.moonScore === undefined ? null : Math.round(item.moonScore),
    weather: item.weather.score === null || item.weather.score === undefined ? null : item.weather.score,
    foreground: ignored.includes('foreground') ? null : Math.round(item.fg.score),
    // 保留细分，便于排查
    visibility: Math.round(item.vis),
    event: Math.round(item.evt.score),
    // 不参与本次评分的维度（日食不含光污染/月相；行星与深空不含地景；缺天气时天气不参与）
    ignored,
    // 实际参与加权的维度数（少于 5 时，总分已按剩余权重换算为百分制）
    participating: dimScores.length,
  }
  return {
    rank,
    score: Math.round(item.score * 10) / 10,
    breakdown,
    reasonDetail,
    target: {
      id: target.id, name: item.label ?? target.name, type: target.type, typeLabel: typeLabelOf(target),
      subtype: target.subtype ?? null, minBortle: target.minBortle, tips: target.tips,
      // 合：两颗天体的角距（焦段就是按它算的）
      separation: target.type === 'conjunction' ? (Number(target.event?.sepDeg) || null) : null,
      // 彗星：视星等 / 距日角 / 距地与日心距，供详情便签直读
      mag: item.cometInfo ? Math.round(item.cometInfo.mag * 10) / 10 : null,
      elongation: item.cometInfo ? Math.round(item.cometInfo.elongation) : null,
      deltaAu: item.cometInfo ? Math.round(item.cometInfo.delta * 100) / 100 : null,
      rAu: item.cometInfo ? Math.round(item.cometInfo.r * 100) / 100 : null,
    },
    site: {
      id: site.id, name: site.name, province: site.province, region: site.region,
      bortle: site.bortle, lat: site.lat, lon: site.lon, altM: site.altM, note: site.note,
      distanceKm,
    },
    distanceKm,
    driveKm,
    date,
    window: {
      start: astro.localHHMM(item.start), end: astro.localHHMM(item.end),
      // 带日期的起止（夜跨零点时起止不在同一天）
      startAt, endAt,
      startShort: astro.localShortDateTime(item.start),
      endShort: astro.localShortDateTime(item.end),
      startDate: astro.localDateString(item.start),
      endDate: astro.localDateString(item.end),
      hours: Math.round(item.hours * 10) / 10,
      moon: { illum: Math.round(nc.moonIllum * 10) / 10, phase: nc.moonPhase },
    },
    geometry: {
      altMax: Math.round(item.altMax * 10) / 10,
      // 最高点那一刻的方位（方向名 + 方位角），便签「最高高度」直接读
      azMax: Math.round(item.azMax ?? (item.azStart + item.azEnd) / 2),
      directionAtMax: astro.azName(item.azMax ?? (item.azStart + item.azEnd) / 2),
      azStart: Math.round(item.azStart),
      azEnd: Math.round(item.azEnd),
      direction: astro.azName((item.azStart + item.azEnd) / 2),
    },
    params,
    // 画面模拟数据（天幕视角 + 取景框 + 地景剪影）；withSim 关闭时为 null
    sim,
    foreground: {
      name: item.fg.name,
      score: Math.round(item.fg.score * 10) / 10,
      match: Math.round((item.fg.match ?? 0) * 100),
      irreplaceability: Math.round((item.fg.irreplaceability ?? 0) * 100),
      sharedBy: item.fg.sharedBy ?? 0,
    },
    weather: item.weather,
    reasons,
  }
}

/** 单站单夜时间轴。 */
export function timeline(siteId, dateStr, raw = {}) {
  resetWeatherBreaker()
  const site = catalog.SITE_BY_ID.get(siteId)
  if (!site) return { ok: false, error: 'no_site', message: `未知站点 ${siteId}` }
  const nc = astro.nightContext(site, dateStr)
  if (!nc.dusk || !nc.dawn) return { ok: false, error: 'no_night', message: '该日没有天文暗夜' }
  const grid = nightGrid(site, dateStr, nc, null, { full: true })
  const hourRows = []
  for (let h = 0; h < 24; h += 1) {
    hourRows.push(astro.localDate(dateStr, `${String(h).padStart(2, '0')}:00`))
  }
  const targets = catalog.TARGETS.filter((t) => t.type !== 'lunarEclipse' && t.type !== 'solarEclipse')
  const threshold = raw.minAltitude !== undefined && raw.minAltitude !== null && raw.minAltitude !== ''
    ? Number(raw.minAltitude)
    : 25
  const bestAt = (date) => {
    const time = astro.makeTime(date)
    return targets.map((t) => ({ target: t, pos: astro.targetAltAz(t, time, site) }))
      .filter((x) => x.pos.alt >= threshold)
      .sort((a, b) => b.pos.alt - a.pos.alt)
      .slice(0, 3)
  }
  return {
    ok: true,
    site: { id: site.id, name: site.name, bortle: site.bortle, lat: site.lat, lon: site.lon, altM: site.altM },
    date: dateStr,
    context: {
      sunset: nc.sunset ? astro.localHHMM(nc.sunset) : null,
      dusk: astro.localHHMM(nc.dusk),
      dawn: astro.localHHMM(nc.dawn),
      sunrise: nc.sunrise ? astro.localHHMM(nc.sunrise) : null,
      moonset: nc.moonset ? astro.localHHMM(nc.moonset) : null,
      moonrise: nc.moonrise ? astro.localHHMM(nc.moonrise) : null,
      moonIllum: Math.round(nc.moonIllum * 10) / 10,
      moonPhase: nc.moonPhase,
    },
    grid: grid.times.map((t, i) => ({
      time: astro.localHHMM(t),
      sunAlt: Math.round(grid.sun[i]),
      moonAlt: Math.round(grid.moon[i]),
    })),
    hours: hourRows.map((d) => {
      const list = bestAt(d)
      return {
        time: astro.localHHMM(d),
        top: list.map((x) => ({ name: x.target.name, alt: Math.round(x.pos.alt), az: Math.round(x.pos.az) })),
      }
    }),
  }
}

export function meta() {
  const stats = catalog.siteStats()
  const db = database.databaseStatus()
  return {
    eventTypes: EVENT_TYPES.map((id) => ({ id, label: TYPE_LABEL[id], group: TYPE_GROUP_OF[id] ?? null })),
    eventTypeGroups: EVENT_TYPE_GROUPS.map((g) => ({ id: g.id, label: g.label })),
    regions: catalog.REGIONS,
    // 三级地点：地区 → 省份（含所属地区） → 具体站点
    provinces: Object.entries(catalog.PROVINCES).map(([name, v]) => ({ name, region: v[0] })),
    cities: Object.entries(catalog.CITIES).map(([name, [lat, lon]]) => ({ name, lat, lon })),
    sites: catalog.siteListCompact(),
    targets: catalog.targetListCompact(),
    formats: ['ff', 'aps-c'],
    stats,
    weather: weatherCoverage(),
    // 数据库更新时间：彗星库每周首次启动自动重建，这里是当前快照的时间（北京时间）
    database: {
      updatedAt: db.updatedAt,
      updatedAtText: dbUpdatedText(db.updatedAt),
      cometCount: db.cometCount,
      siteCount: stats.total,
      targetCount: catalog.TARGETS.length,
      source: db.source,
      refreshDays: db.refreshDays,
      lastAttemptAt: db.lastAttemptAt,
      lastError: db.lastError,
      running: db.running,
    },
    comets: {
      count: comets.COMETS.length,
      fetched: comets.COMET_META.fetched,
      updatedAt: comets.COMET_META.updatedAt,
      source: comets.COMET_META.source,
      maxMag: MAX_COMET_MAG,
      minElongation: MIN_COMET_ELONGATION,
      list: comets.COMETS.map((c) => ({ id: c.id, name: c.name, minMag: c.minMag, minMagAt: c.minMagAt })),
    },
    // 画面模拟的静态星表（亮星 / 星座连线 / 黄道），页面与 Tab 各取一次
    sky: skyview.skyMeta(),
    today: todayLocal(),
  }
}
