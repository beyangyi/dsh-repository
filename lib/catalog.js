/**
 * dsh-astro-plan — 数据层：站点库 / 目标库 / 事件表 / 参数规则。
 *
 * 站点库为人工整理（坐标取地标/山峰/湖岸/观景台，精度 0.01–0.05°），
 * 光污染为经验估计（Bortle），显式标注 estimated。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(HERE, 'data')

function loadJson(name) {
  return JSON.parse(readFileSync(join(DATA, name), 'utf8'))
}

const sitesRaw = loadJson('sites-core.json')
const provinceRaw = loadJson('sites-province.json')
const targetsRaw = loadJson('targets.json').targets
const eventsRaw = loadJson('events.json')
const paramsRaw = loadJson('params.json')

const TAG_MAP = {
  m: 'milkyway', d: 'deepsky', r: 'meteor', t: 'startrail', l: 'nightscape', a: 'aurora',
}

export const REGIONS = ['华北', '东北', '西北', '西南', '华东', '华中', '华南', '港澳台']

/** "名:0-360;名:240-300" → [{name, azFrom, azTo}] */
export function parseForegrounds(text) {
  if (!text) return []
  return String(text).split(';').map((chunk) => chunk.trim()).filter(Boolean).map((chunk) => {
    const idx = chunk.lastIndexOf(':')
    if (idx < 0) return { name: chunk, azFrom: 0, azTo: 360 }
    const name = chunk.slice(0, idx)
    const [a, b] = chunk.slice(idx + 1).split('-').map(Number)
    return { name, azFrom: Number.isFinite(a) ? a : 0, azTo: Number.isFinite(b) ? b : 360 }
  })
}

function parseTags(text) {
  return String(text || '').split('').map((c) => TAG_MAP[c]).filter(Boolean)
}

function expand(row) {
  const [id, name, province, region, lat, lon, altM, bortle, tags, fg, note] = row
  return {
    id, name, province, region,
    lat, lon, altM, bortle,
    tags: parseTags(tags),
    foregrounds: parseForegrounds(fg),
    note,
    bortleConfidence: 'estimated',
    coordConfidence: 'approx',
  }
}

let userSites = []
try {
  userSites = JSON.parse(readFileSync(join(DATA, 'sites.user.json'), 'utf8')).rows.map(expand)
} catch {
  userSites = []
}

const builtinSites = sitesRaw.rows.map(expand)
const userOverrideIds = new Set(userSites.map((s) => s.id))
export const SITES = [...builtinSites.filter((s) => !userOverrideIds.has(s.id)), ...userSites]

export const TARGETS = targetsRaw
export const EVENTS = eventsRaw
export const PARAMS = paramsRaw
export const PROVINCES = provinceRaw.provinces
export const CITIES = provinceRaw.cities

export const SITE_BY_ID = new Map(SITES.map((s) => [s.id, s]))
export const TARGET_BY_ID = new Map(TARGETS.map((t) => [t.id, t]))

/** 省份 → 区域 */
export function regionOfProvince(province) {
  return PROVINCES[province]?.[0] ?? null
}

/** 站点概要（给 UI 下拉用）。 */
export function siteListCompact() {
  return SITES.map((s) => ({
    id: s.id, name: s.name, province: s.province, region: s.region,
    bortle: s.bortle, altM: s.altM, lat: s.lat, lon: s.lon, note: s.note,
  }))
}

/** 站点覆盖率统计（验收用）。 */
export function siteStats() {
  const byProvince = {}
  for (const s of SITES) byProvince[s.province] = (byProvince[s.province] || 0) + 1
  const byRegion = {}
  for (const s of SITES) byRegion[s.region] = (byRegion[s.region] || 0) + 1
  return {
    total: SITES.length,
    provinces: Object.keys(byProvince).length,
    byProvince,
    byRegion,
    avgBortle: SITES.reduce((a, s) => a + s.bortle, 0) / SITES.length,
  }
}

/** 球面距离 km。 */
export function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

/** 最近的若干站点。 */
export function nearestSites(lat, lon, limit = 5) {
  return SITES
    .map((s) => ({ site: s, km: distanceKm(lat, lon, s.lat, s.lon) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, limit)
}

/**
 * 解析 location：
 *   - 空 / "全国" → 全部
 *   - 站点 id / 站点名（含模糊） → 命中站点
 *   - 城市名（sites-province.cities）→ 最近 5 站
 *   - 省名 / 区域名 → 该范围内的站点
 *   - "lat,lon" → 最近 5 站
 */
/** 地图选点：用任意经纬度合成一个与站点同构的对象（近似字段都标注清楚）。 */
export function customSite({ lat, lon, bortle, name } = {}) {
  const la = Math.max(-90, Math.min(90, Number(lat)))
  const lo = Number.isFinite(Number(lon)) ? ((((Number(lon) + 540) % 360) + 360) % 360) - 180 : NaN
  if (!Number.isFinite(la) || !Number.isFinite(lo)) throw new Error('坐标必须是数字')
  const near = nearestSites(la, lo, 3)
  const nearest = near[0] ?? null
  const anchor = nearest && nearest.km <= 200 ? nearest.site : null
  const weighted = near.filter((x) => x.km <= 200)
  const bortleEst = weighted.length
    ? Math.round(weighted.reduce((sum, x) => sum + x.site.bortle / Math.max(1, x.km), 0)
      / weighted.reduce((sum, x) => sum + 1 / Math.max(1, x.km), 0))
    : 4
  const altM = nearest && nearest.km <= 100 ? nearest.site.altM : 0
  const horizonFrom = nearest && nearest.km <= 300 ? nearest.site.id : null
  const given = Number(bortle)
  return {
    id: `custom:${la.toFixed(3)},${lo.toFixed(3)}`,
    name: name || `自定义点 ${la.toFixed(3)},${lo.toFixed(3)}`,
    province: anchor ? anchor.province : '自定义',
    region: anchor ? anchor.region : '自定义',
    lat: la,
    lon: lo,
    altM,
    bortle: given >= 1 && given <= 9 ? Math.round(given) : Math.max(1, Math.min(9, bortleEst)),
    tags: anchor ? anchor.tags : [],
    foregrounds: anchor ? anchor.foregrounds : [],
    note: anchor
      ? `按地图选点近似：天际线与地景取自最近站点「${anchor.name}」（${Math.round(nearest.km)} km），波特尔按邻近站点估算`
      : '按地图选点：附近没有站点，天际线用先验剪影，波特尔为估算值',
    bortleConfidence: 'estimated',
    coordConfidence: 'user',
    custom: true,
    horizonFrom,
  }
}

export function resolveLocation(location, { region, province } = {}) {
  let pool = [...SITES]
  const notes = []
  const loc = String(location ?? '').trim()

  if (region && region !== '全国') {
    pool = pool.filter((s) => s.region === region)
  }
  if (province) {
    pool = pool.filter((s) => s.province === province)
  }

  if (!loc || loc === '全国' || loc === 'all') {
    return { sites: pool, notes }
  }

  const direct = SITE_BY_ID.get(loc) || SITES.find((s) => s.name === loc)
  if (direct) return { sites: [direct], notes }

  const fuzzy = SITES.filter((s) => s.name.includes(loc) || s.province.includes(loc))
  if (fuzzy.length > 0) {
    return { sites: fuzzy, notes: [`按关键字「${loc}」匹配到 ${fuzzy.length} 个站点`] }
  }

  if (CITIES[loc]) {
    const [lat, lon] = CITIES[loc]
    const near = nearestSites(lat, lon, 5)
    return {
      sites: near.map((x) => x.site),
      notes: [`「${loc}」不是站点，已按距离取最近 5 站：${near.map((x) => `${x.site.name}(${Math.round(x.km)}km)`).join('、')}`],
    }
  }

  const explicit = /^@\s*(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(loc)
  if (explicit) {
    const site = customSite({ lat: Number(explicit[1]), lon: Number(explicit[2]) })
    return { sites: [site], notes: [site.note] }
  }

  const coord = /^\s*(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(loc)
  if (coord) {
    const lat = Number(coord[1]); const lon = Number(coord[2])
    const near = nearestSites(lat, lon, 5)
    return {
      sites: near.map((x) => x.site),
      notes: [`按坐标 (${lat}, ${lon}) 取最近 5 站：${near.map((x) => `${x.site.name}(${Math.round(x.km)}km)`).join('、')}`],
    }
  }

  if (REGIONS.includes(loc)) {
    return { sites: pool.filter((s) => s.region === loc), notes: [] }
  }
  if (PROVINCES[loc]) {
    return { sites: pool.filter((s) => s.province === loc), notes: [] }
  }

  return { sites: [], notes: [`无法解析地点「${loc}」。可用：站点名 / 城市名 / 省份 / 区域 / "lat,lon" / 全国`] }
}

/**
 * 事件：落在 [from, to] 内（含前后 padDays 天）。
 * 只覆盖流星雨——日食/月食/冲日/合由 lib/events.js 按星历现算。
 */
export function eventsBetween(fromDate, toDate, padDays = 0) {
  const from = fromDate.getTime() - padDays * 86400000
  const to = toDate.getTime() + padDays * 86400000
  const inRange = (iso) => {
    const t = new Date(iso).getTime()
    return t >= from && t <= to
  }
  return {
    meteors: EVENTS.meteors.filter((m) => inRange(m.peakUtc)),
  }
}

/**
 * 目标是否在活跃月份。
 * months 支持两种写法：[from, to]（单窗口，可跨年）或 [[a,b],[c,d]]（多窗口）。
 */
export function inSeason(target, month) {
  const ranges = Array.isArray(target.months[0]) ? target.months : [target.months]
  return ranges.some(([a, b]) => (a <= b ? month >= a && month <= b : month >= a || month <= b))
}

export function targetListCompact() {
  return TARGETS.map((t) => ({ id: t.id, name: t.name, type: t.type, subtype: t.subtype ?? null, months: t.months }))
}
