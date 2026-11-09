/**
 * dsh-astro-plan — 画面模拟 v2：3D 天球场景数据 + 浏览器渲染器源码。
 *
 * 服务端：
 *   1. 读 lib/data/sky.json（亮星 / 星座连线，J2000），岁差到当天；
 *   2. `skyMeta()` 生成 meta.sky（星表 + 星座 + 黄道），页面与 Tab 各取一次；
 *   3. `buildSim()` 逐帧算：恒星时、目标/行星/日月 RA/Dec、彗尾方向与长度、流星线段。
 *
 * 浏览器（RENDER_SRC，纯函数、零依赖）：
 *   赤道→地平、透视相机投影，按图层画天球（星、星座、黄道、行星、日月、彗星、流星）。
 * 页面脚本与会话 Tab 共用同一份源码（tests/sky.test.js 校验两份一致）。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as astro from './astro.js'
import * as catalog from './catalog.js'
import * as comets from './comets.js'
import { PLANET_CN } from './events.js'
import { foregroundModels, skyline } from './scene.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const D2R = Math.PI / 180
const R2D = 180 / Math.PI
const OBLIQ = 23.4392911 * D2R

export const SIM_WIDTH = 480
export const SIM_HEIGHT = 270
const MAX_FRAMES = 72
const MIN_STEP_MIN = 3
const FOV = 100
const MIN_FOV = 5
const MAX_FOV = 180
const AU_KM = 149597870.7
const MOON = 'Moon'

const BODY_LIST = [
  ['水星', 'Mercury'], ['金星', 'Venus'], ['火星', 'Mars'],
  ['木星', 'Jupiter'], ['土星', 'Saturn'], ['太阳', 'Sun'], ['月球', MOON],
]
const BODY_CN = Object.fromEntries(BODY_LIST.map(([cn, en]) => [en, cn]))

const r2 = (v) => Math.round(v * 100) / 100
const r1 = (v) => Math.round(v * 10) / 10
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/* ---------------- 星表 ---------------- */

const RAW = (() => {
  try {
    return JSON.parse(readFileSync(join(HERE, 'data', 'sky.json'), 'utf8'))
  } catch {
    return { stars: [], constellations: [] }
  }
})()

let cacheKey = null
let cache = null

/** J2000 星表 → 当天赤道坐标（岁差），按本地日期缓存。 */
export function ofDateCatalog(now = new Date()) {
  const key = astro.localDateString(now)
  if (cacheKey === key && cache) return cache
  const time = astro.makeTime(now)
  const stars = (RAW.stars ?? []).map(([ra, dec, mag, name]) => {
    const p = astro.ofDateRADec(ra, dec, time)
    return [r2(p.raDeg), r2(p.dec), mag, name || '']
  })
  const lines = (RAW.constellations ?? []).map((c) => ({
    n: c.n,
    paths: c.paths.map((path) => path.map(([ra, dec]) => {
      const p = astro.ofDateRADec(ra, dec, time)
      return [r2(p.raDeg), r2(p.dec)]
    })),
  }))
  const milkyway = (RAW.milkyway ?? []).map((level) => ({
    level: level.level,
    polys: level.polys.map((rings) => rings.map((ring) => ring.map(([ra, dec]) => {
      const p = astro.ofDateRADec(ra, dec, time)
      return [r2(p.raDeg), r2(p.dec)]
    }))),
  }))
  cacheKey = key
  cache = { stars, lines, milkyway }
  return cache
}

/** 黄道（赤道 of-date 坐标，72 点）。 */
export function eclipticPoints(stepDeg = 5) {
  const out = []
  for (let lam = 0; lam < 360; lam += stepDeg) {
    const l = lam * D2R
    const ra = Math.atan2(Math.cos(OBLIQ) * Math.sin(l), Math.cos(l)) * R2D
    const dec = Math.asin(Math.sin(OBLIQ) * Math.sin(l)) * R2D
    out.push([r2(((ra % 360) + 360) % 360), r2(dec)])
  }
  return out
}

/** /api/meta 用：星表 + 星座连线 + 黄道 + 银河等值线（一次性，约 80 KB）。 */
export function skyMeta(now = new Date()) {
  const { stars, lines, milkyway } = ofDateCatalog(now)
  return {
    stars,
    lines,
    ecliptic: eclipticPoints(),
    milkyway,
    count: (RAW.stars ?? []).length,
  }
}

/* ---------------- 坐标工具 ---------------- */

export function eqToAltAz(raDeg, decDeg, lstH, latDeg) {
  const H = (lstH * 15 - raDeg) * D2R
  const phi = latDeg * D2R
  const dec = decDeg * D2R
  const sinAlt = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)
  const alt = Math.asin(clamp(sinAlt, -1, 1)) * R2D
  const az = Math.atan2(
    -Math.cos(dec) * Math.sin(H),
    Math.sin(dec) * Math.cos(phi) - Math.cos(dec) * Math.sin(phi) * Math.cos(H),
  ) * R2D
  return { alt, az: ((az % 360) + 360) % 360 }
}

function bodyRaDec(body, time, observer) {
  const eq = astro.A.Equator(astro.A.Body[body], time, observer, true, true)
  return [eq.ra * 15, eq.dec]
}

function vectorRaDec(vecJ2000, time) {
  const eqd = astro.A.RotateVector(astro.A.Rotation_EQJ_EQD(time), vecJ2000)
  const sph = astro.A.EquatorFromVector(eqd)
  return [(((sph.ra * 15) % 360) + 360) % 360, sph.dec]
}

function skyKindOf(sunAlt) {
  if (sunAlt > -6) return 'day'
  if (sunAlt > -18) return 'twilight'
  return 'night'
}

export function paletteOf(sky, bortle) {
  if (sky === 'day') return { gradient: ['#3f74c9', '#7aa8e6', '#cfe0f5'], ground: '#28313a', label: '#10305c' }
  if (sky === 'twilight') return { gradient: ['#1b2340', '#4a3f63', '#b06a4a'], ground: '#0a0c12', label: '#ffd9a8' }
  // 夜间底色压暗，保证任何波特尔等级下都比银河暗
  if (bortle <= 2) return { gradient: ['#02040a', '#050a12', '#0a1220'], ground: '#04060a', label: '#cfe0f7' }
  if (bortle <= 4) return { gradient: ['#04070f', '#070d18', '#0e1626'], ground: '#05070c', label: '#cfe0f7' }
  if (bortle <= 6) return { gradient: ['#070b14', '#0d1422', '#151d2e'], ground: '#07090f', label: '#d7e2f2' }
  return { gradient: ['#0b101a', '#111827', '#1a2133'], ground: '#0a0c12', label: '#e6edf8' }
}

/* ---------------- 流星 / 彗尾 ---------------- */

function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a += 0x6d2b79f5
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashStr(text) {
  let h = 2166136261
  for (const ch of String(text)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return h >>> 0
}

/** 从 (ra,dec) 沿大圆走 distDeg（bearing 为方位）到达的点。 */
function moveAlong(raDeg, decDeg, bearingDeg, distDeg) {
  const d = distDeg * D2R
  const b = bearingDeg * D2R
  const dec1 = decDeg * D2R
  const ra1 = raDeg * D2R
  const sinDec2 = Math.sin(dec1) * Math.cos(d) + Math.cos(dec1) * Math.sin(d) * Math.cos(b)
  const dec2 = Math.asin(clamp(sinDec2, -1, 1))
  const dRa = Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(dec1), Math.cos(d) - Math.sin(dec1) * sinDec2)
  return [((((ra1 + dRa) * R2D) % 360) + 360) % 360, dec2 * R2D]
}

/** 流星雨：从辐射点向外发散的线段（确定性伪随机）。 */
export function meteorFrames(radiant, frameCount, seed, speedKmS = 50) {
  const out = Array.from({ length: frameCount }, () => [])
  const lengthScale = clamp(Number(speedKmS) / 45 || 1, 0.7, 1.4)
  const rnd = mulberry32(hashStr(seed))
  const events = 10 + Math.floor(rnd() * 8)
  for (let e = 0; e < events; e += 1) {
    const start = Math.floor(rnd() * frameCount)
    const life = 2 + Math.floor(rnd() * 2)
    const bearing = rnd() * 360
    const d0 = 2 + rnd() * 12
    const len = (6 + rnd() * 18) * lengthScale
    const bright = 0.35 + rnd() * 0.65
    for (let f = start; f < Math.min(frameCount, start + life); f += 1) {
      const p0 = (f - start + 1) / life
      const a = moveAlong(radiant[0], radiant[1], bearing, d0 + len * p0)
      const b = moveAlong(radiant[0], radiant[1], bearing, d0 + len * (p0 + 0.45))
      out[f].push([r2(a[0]), r2(a[1]), r2(b[0]), r2(b[1]), r2(bright * (1 - p0 * 0.7))])
    }
  }
  return out
}

/** 彗尾长度（度）：按视星等与地心距估算，1.5°–25°。 */
export function cometTailDeg(mag, deltaAu) {
  const delta = Math.max(0.2, Number(deltaAu) || 1)
  const base = 0.06 + 0.02 * Math.max(0, 9 - (Number(mag) || 9))
  return clamp((base / delta) * R2D, 1.5, 25)
}

/* ---------------- sim 构建 ---------------- */

/**
 * 多个目标方向（tp 的 [alt, az]）的质心，返回 { alt, az }。
 * 合 / 双目标时取质心，把它们对称摆在画面中心两侧；空数组返回 null。
 */
export function tpCenterOf(tp) {
  if (!Array.isArray(tp) || !tp.length) return null
  let x = 0
  let y = 0
  let z = 0
  for (const p of tp) {
    const a = (Number(p?.[2]) || 0) * D2R
    const az = (Number(p?.[3]) || 0) * D2R
    x += Math.cos(a) * Math.sin(az)
    y += Math.cos(a) * Math.cos(az)
    z += Math.sin(a)
  }
  const n = Math.hypot(x, y, z)
  if (n < 1e-9) return null
  return {
    alt: Math.asin(Math.max(-1, Math.min(1, z / n))) * R2D,
    az: ((Math.atan2(x / n, y / n) * R2D) + 360) % 360,
  }
}

/** 两个目标方向之间的球面角距（度）；少于两个目标返回 0。 */
export function tpSpreadDeg(tp) {
  if (!Array.isArray(tp) || tp.length < 2) return 0
  const dir = (p) => {
    const a = (Number(p?.[2]) || 0) * D2R
    const az = (Number(p?.[3]) || 0) * D2R
    return [Math.cos(a) * Math.sin(az), Math.cos(a) * Math.cos(az), Math.sin(a)]
  }
  const u = dir(tp[0])
  const v = dir(tp[1])
  const dot = u[0] * v[0] + u[1] * v[1] + u[2] * v[2]
  return Math.acos(Math.max(-1, Math.min(1, dot))) * R2D
}

export function buildSim({ item, target, site, params }) {
  if (!item || !target || !site) return null
  if (target.type === 'aurora') return { version: 2, skip: 'aurora' }
  const start = item.start
  const end = item.end
  if (!(start instanceof Date) || !(end instanceof Date) || !(end > start)) return null

  // 播放区间向两侧各扩 6 h：可以拖到最佳时段前后看天光变化
  const PAD_MS = 6 * 3600 * 1000
  const rangeStart = new Date(start.getTime() - PAD_MS)
  const rangeEnd = new Date(end.getTime() + PAD_MS)
  const spanMin = (rangeEnd.getTime() - rangeStart.getTime()) / 60000
  const stepMin = Math.max(MIN_STEP_MIN, Math.ceil(spanMin / (MAX_FRAMES - 1)))
  let times = []
  for (let t = rangeStart.getTime(); t < rangeEnd.getTime(); t += stepMin * 60000) times.push(new Date(t))
  times.push(rangeEnd)
  if (times.length < 5) {
    const t0 = rangeStart.getTime()
    const t1 = rangeEnd.getTime()
    times = Array.from({ length: 5 }, (_, i) => new Date(Math.round(t0 + ((t1 - t0) * i) / 4)))
  }

  const observer = astro.observerOf(site)
  // 窗口中点（相机取景、天空类型都用它；逐帧另有各自的太阳高度）
  const winMid = new Date((start.getTime() + end.getTime()) / 2)
  const midTime = astro.makeTime(winMid)

  const starRaDec = target.raH != null
    ? (() => { const p = astro.ofDateRADec(target.raH * 15, target.dec, midTime); return [p.raDeg, p.dec] })()
    : null

  // 站点实际可见的标签（月食只在部分阶段可见时规划层会改成「月偏食」）
  const targetsMeta = describeTargets(target, item.label)

  const frames = times.map((t) => {
    const time = astro.makeTime(t)
    const lst = astro.lstHours(time, site.lon)
    const sunAlt = astro.bodyAltAz('Sun', time, site).alt
    const radecs = targetRaDecs(target, starRaDec, time, observer)
    const tp = radecs.map(([ra, dec]) => {
      const p = eqToAltAz(ra, dec, lst, site.lat)
      return [r2(ra), r2(dec), r1(p.alt), r1(p.az)]
    })

    const bodies = []
    for (let bi = 0; bi < BODY_LIST.length; bi += 1) {
      // 月亮单独走 f.moon（要画相位、只画一次），不再塞进 bodies
      if (BODY_LIST[bi][1] === MOON) continue
      try {
        const [ra, dec] = bodyRaDec(BODY_LIST[bi][1], time, observer)
        const p = eqToAltAz(ra, dec, lst, site.lat)
        if (p.alt > -2) bodies.push([r2(ra), r2(dec), bi, Math.round(bodySizeDeg(BODY_LIST[bi][1], time) * 100) / 100])
      } catch { /* 单颗失败不影响整帧 */ }
    }

    // 月球：不管它是不是目标，都走同一条绘制路径（带相位、只标一次名字）
    let moon = null
    {
      const [ra, dec] = bodyRaDec(MOON, time, observer)
      const p = eqToAltAz(ra, dec, lst, site.lat)
      if (p.alt > -2) moon = [r2(ra), r2(dec), r1(astro.moonIllumPercent(time)), bodySizeDeg(MOON, time)]
    }

    // 太阳的地平坐标：画月相时要让亮面朝向太阳
    let sunAA = null
    try {
      const [ra, dec] = bodyRaDec('Sun', time, observer)
      const p = eqToAltAz(ra, dec, lst, site.lat)
      sunAA = [r1(p.alt), r1(p.az)]
    } catch { sunAA = null }

    let comet = null
    if (target.type === 'comet' && target.comet) {
      const st = comets.cometState(target.comet, time.date ?? time)
      const head = tp[0]
      const deg = Math.round(cometTailDeg(st.mag, st.delta) * 10) / 10
      const earth = astro.A.HelioVector(astro.A.Body.Earth, time)
      const v = st.vec
      const vn = Math.hypot(v.x, v.y, v.z) || 1
      const u = { x: v.x + earth.x, y: v.y + earth.y, z: v.z + earth.z }
      const dotUV = (u.x * v.x + u.y * v.y + u.z * v.z) / vn
      const px = u.x - dotUV * (v.x / vn)
      const py = u.y - dotUV * (v.y / vn)
      const pz = u.z - dotUV * (v.z / vn)
      const pn = Math.hypot(px, py, pz) || 1
      const L = deg * D2R
      const tip = {
        x: (v.x / vn) * Math.cos(L) + (px / pn) * Math.sin(L),
        y: (v.y / vn) * Math.cos(L) + (py / pn) * Math.sin(L),
        z: (v.z / vn) * Math.cos(L) + (pz / pn) * Math.sin(L),
        t: time,
      }
      const tipRaDec = vectorRaDec(tip, time)
      comet = { head: [head[0], head[1]], tip: [r2(tipRaDec[0]), r2(tipRaDec[1])], deg }
    }

    return {
      t: astro.localHHMM(t),
      d: astro.localDateString(t).slice(5),
      lst: Math.round(lst * 10000) / 10000,
      sun: r1(sunAlt),
      w: t >= start && t <= end ? 1 : 0,
      tp,
      bodies,
      moon,
      // 月食：整晚的等效食分（0–1），用来把月球压暗偏红；其它题材为 0
      moonObsc: target.type === 'lunarEclipse' ? Math.max(0, Math.min(1, Number(item.obscuration) || 0)) : 0,
      sunAA,
      comet,
      meteors: [],
    }
  })

  // 流星雨：辐射点岁差到当天，逐帧线段
  let radiant = null
  if (target.type === 'meteor' && target.raH != null) {
    const p = astro.ofDateRADec(target.raH * 15, target.dec, midTime)
    radiant = [r2(p.raDeg), r2(p.dec)]
    const perFrame = meteorFrames(radiant, frames.length, `${site.id}|${item.date}|${target.id}`, target.speed ?? 50)
    frames.forEach((f, i) => { f.meteors = perFrame[i] })
  }

  // 天空类型：窗口中点太阳高度（日食强制白天）
  const sunAlt = astro.bodyAltAz('Sun', midTime, site).alt
  const sky = target.type === 'solarEclipse' ? 'day' : skyKindOf(sunAlt)
  const palette = paletteOf(sky, site.bortle)

  // 相机：以「默认显示的那一帧」的目标位置定视角，目标正好在画面正中；
  // 多目标（如合）取各目标方向的质心，让它们对称分布在中心两侧。
  let startIndex = Math.max(0, frames.findIndex((f) => f.w === 1))
  const center = tpCenterOf(frames[startIndex]?.tp) ?? { alt: 30, az: 180 }
  const yaw = r1(center.az)
  const pitch = r1(clamp(center.alt, 0, 90))
  // 合的初始帧是「最佳时段开始」，两颗此时可能已经拉开：视场按该帧的实际角距放大，保证两颗都在画面里
  const startSpread = target.type === 'conjunction' ? tpSpreadDeg(frames[startIndex]?.tp) : 0
  const camFov = startSpread > 0 ? Math.max(defaultFov(target, params?.ffFocalMid), Math.min(90, startSpread * 2.4)) : defaultFov(target, params?.ffFocalMid)
  const focal = Math.max(1, Number(params?.ffFocalMid) || 50)
  const fovH = 2 * Math.atan(36 / (2 * focal)) * R2D
  const fovV = 2 * Math.atan(24 / (2 * focal)) * R2D

  // 地景：整圈天际线来自实测高程剖面（近景 0.8–20 km / 远景 40–140 km）
  const terrain = skyline(site)
  const models = foregroundModels(site)
  const ridge = terrain.near
  const ridgeFar = terrain.far

  const fgText = models.slice(0, 3)
    .map((m) => `${m.name} ${Math.round(m.azFrom)}–${Math.round(m.azTo)}°`).join('、')

  return {
    version: 3,
    skip: null,
    startIndex,
    kind: target.type,
    sky,
    palette,
    palettes: {
      night: paletteOf('night', site.bortle),
      twilight: paletteOf('twilight', site.bortle),
      day: paletteOf('day', site.bortle),
    },
    lat: site.lat,
    lon: site.lon,
    bortle: site.bortle,
    altM: site.altM,
    window: { start: astro.localHHMM(start), end: astro.localHHMM(end) },
    targets: targetsMeta,
    bodyNames: BODY_LIST.map(([cn]) => cn),
    camera: {
      yaw, pitch, fov: camFov, tracker: Boolean(params?.trackerNeeded),
      focal: Math.round(focal), fovH: r1(fovH), fovV: r1(fovV),
    },
    frames,
    radiant,
    ridge,
    ridgeFar,
    foregrounds: models.map((m) => ({
      name: m.name, azFrom: m.azFrom, azTo: m.azTo, heightDeg: m.heightDeg, kind: m.kind,
    })),
    terrainSource: terrain.source,
    reliefDeg: terrain.relief,
    caption: `3D 天球 · ${Math.round(focal)}mm（${fovH.toFixed(1)}°×${fovV.toFixed(1)}°）`
      + (fgText ? ` · 地形：${fgText}` : ''),
  }
}

/** 视直径（度）：日月按真实距离算（月亮 0.49°–0.56°、太阳 ≈0.53°），行星返回 0（画成星点）。 */
function bodySizeDeg(body, time) {
  if (body === MOON) {
    const m = astro.A.GeoMoon(time)
    const km = Math.hypot(m.x, m.y, m.z) * AU_KM
    return km > 1 ? 2 * Math.atan(1737.4 / km) * R2D : 0.52
  }
  if (body === 'Sun') {
    const au = astro.A.HelioDistance(astro.A.Body.Earth, time)
    const km = au * AU_KM
    return km > 1 ? 2 * Math.atan(696000 / km) * R2D : 0.53
  }
  return 0
}

function targetRaDecs(target, starRaDec, time, observer) {
  if (target.type === 'comet' && target.comet) {
    const st = comets.cometState(target.comet, time.date ?? time)
    return [vectorRaDec(st.vec, time)]
  }
  if (target.type === 'conjunction') {
    return (target.event?.objects ?? [target.body]).filter(Boolean)
      .map((body) => bodyRaDec(body, time, observer))
  }
  if (target.body) return [bodyRaDec(target.body, time, observer)]
  return starRaDec ? [starRaDec] : []
}

function describeTargets(target, siteLabel) {
  if (target.type === 'conjunction') {
    return (target.event?.objects ?? [target.body]).filter(Boolean).map((body) => ({
      name: body === MOON ? '月球' : (PLANET_CN[body] ?? body),
      kind: kindOf(target.type, body),
      sizeDeg: sizeOf(body, target),
    }))
  }
  // 日月食用站点实际可见的标签（全食/偏食/半影），其余用目录名
  const eclipse = target.type === 'solarEclipse' || target.type === 'lunarEclipse'
  return [{
    name: eclipse && siteLabel ? siteLabel : target.name,
    kind: kindOf(target.type, target.body),
    sizeDeg: sizeOf(target.body, target),
  }]
}

/** 按天象类型给初始视场（度）：深空/行星/食看细节，银河/流星看全景。 */
export function defaultFov(target, focal) {
  const t = target?.type
  // 合：默认视场按两颗的角距放大，且不小于「推荐焦段的画面对角线」，保证取景框整个落在画面里
  if (t === 'conjunction') {
    const sep = Number(target?.event?.sepDeg) || 3
    const focalN = Math.max(1, Number(focal) || 50)
    const diag = 2 * Math.atan(Math.hypot(36, 24) / (2 * focalN)) * 180 / Math.PI
    // 1.3 倍是为了让 4:3 的取景框在 16:9 画布里留出边距（只按对角线算会顶到上下边）
    return Math.max(12, Math.min(70, Math.round(Math.max(sep * 2.5, diag * 1.3) * 10) / 10))
  }
  if (t === 'planet' || t === 'opposition' || t === 'elongation') return 18
  if (t === 'solarEclipse' || t === 'lunarEclipse') return 20
  if (t === 'comet') return 45
  if (t === 'meteor' || t === 'startrail' || t === 'zodiacal') return 110
  if (t === 'milkyway') return 120
  if (t === 'deepsky') return Number(focal) >= 300 ? 40 : 60
  return 100
}

function kindOf(type, body) {
  if (body === MOON) return 'moon'
  if (body === 'Sun') return 'sun'
  if (type === 'comet') return 'comet'
  if (type === 'meteor') return 'meteor'
  if (type === 'startrail') return 'startrail'
  if (type === 'milkyway') return 'milkyway'
  if (type === 'zodiacal') return 'glow'
  if (type === 'deepsky') return 'deepsky'
  if (type === 'planet' || type === 'opposition' || type === 'elongation' || type === 'conjunction') return 'planet'
  return 'point'
}

function sizeOf(body, target) {
  if (body === MOON || body === 'Sun') return 0.52
  if (target?.sizeDeg) return target.sizeDeg
  const hit = catalog.TARGETS.find((t) => t.body === body && t.sizeDeg)
  return hit ? hit.sizeDeg : 0.02
}

/* ---------------- 浏览器渲染器（纯函数，零依赖） ---------------- */

export const RENDER_SRC = String.raw`
var SKY_D2R = Math.PI / 180;

function skyEqToAltAz(ra, dec, lstH, latDeg) {
  var H = (lstH * 15 - ra) * SKY_D2R;
  var phi = latDeg * SKY_D2R, d = dec * SKY_D2R;
  var sinAlt = Math.sin(phi) * Math.sin(d) + Math.cos(phi) * Math.cos(d) * Math.cos(H);
  var alt = Math.asin(Math.max(-1, Math.min(1, sinAlt))) / SKY_D2R;
  var az = Math.atan2(-Math.cos(d) * Math.sin(H), Math.sin(d) * Math.cos(phi) - Math.cos(d) * Math.sin(phi) * Math.cos(H)) / SKY_D2R;
  return { alt: alt, az: ((az % 360) + 360) % 360 };
}
function skyVec(altDeg, azDeg) {
  var a = altDeg * SKY_D2R, z = azDeg * SKY_D2R;
  return [Math.cos(a) * Math.sin(z), Math.cos(a) * Math.cos(z), Math.sin(a)];
}
// 多目标（合）的质心方向；空数组返回 null
function skyTpCenter(tp) {
  if (!tp || !tp.length) return null;
  var x = 0, y = 0, z = 0;
  for (var i = 0; i < tp.length; i += 1) {
    var v = skyVec(tp[i][2] || 0, tp[i][3] || 0);
    x += v[0]; y += v[1]; z += v[2];
  }
  var n = Math.sqrt(x * x + y * y + z * z);
  if (n < 1e-9) return null;
  return { alt: Math.asin(Math.max(-1, Math.min(1, z / n))) / SKY_D2R, az: ((Math.atan2(x, y) / SKY_D2R) + 360) % 360 };
}
// 立体投影（stereographic）：天球投到与视线相切的平面上，r = k·tan(θ/2)。
// 视场 = 画面内切圆的角直径；圆盘半径固定取对角线的一半，
// 保证整幅画面（含四角）都是连续的天空 / 地景，不出现圆形取景框。
function skyDiscRadius(w, h) {
  var W = w || 960, H = h || 540;
  return 0.5 * Math.sqrt(W * W + H * H);
}
function skyBasis(cam, w, h) {
  var y = cam.yaw * SKY_D2R, p = cam.pitch * SKY_D2R;
  var f = [Math.cos(p) * Math.sin(y), Math.cos(p) * Math.cos(y), Math.sin(p)];
  var r = [Math.cos(y), -Math.sin(y), 0];
  var u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  var R = skyDiscRadius(w, h);
  return { f: f, r: r, u: u, R: R, k: R / Math.tan(cam.fov * SKY_D2R / 4) };
}
function skyProject(v, b, w, h) {
  var W = w || 960, H = h || 540;
  var d = v[0] * b.f[0] + v[1] * b.f[1] + v[2] * b.f[2];
  if (d < 0) return null;               // 只投前半球；180° 视场时四角正好 d = 0
  var den = 1 + d;                      // tan(θ/2)
  var tx = v[0] * b.r[0] + v[1] * b.r[1] + v[2] * b.r[2];
  var ty = v[0] * b.u[0] + v[1] * b.u[1] + v[2] * b.u[2];
  var x = 0.5 + (b.k * tx / den) / W;
  var y = 0.5 - (b.k * ty / den) / H;
  if (x < -0.12 || x > 1.12 || y < -0.12 || y > 1.12) return null;
  return { x: x, y: y };
}
function skyFmtRa(ra) {
  var h = ((ra / 15) % 24 + 24) % 24;
  var hh = Math.floor(h);
  var mm = Math.round((h - hh) * 60);
  if (mm === 60) { hh = (hh + 1) % 24; mm = 0; }
  return hh + 'h' + (mm < 10 ? '0' : '') + mm + 'm';
}

function skyRender(ctx, view, k) {
  var sim = view.sim, meta = view.sky || {}, camIn = view.camera || sim.camera;
  var W = view.w || 480, H = view.h || 270;
  var f = sim.frames[k];
  if (!f) return;
  var S = W / 480;
  var fov = Math.max(5, Math.min(180, camIn.fov || 100));
  // 赤道仪跟踪时相机跟着目标走（目标恒在画面正中、地景掠过）；手动拖拽后按拖拽的视角
  var follow = !view.free
    && Boolean(camIn.tracker != null ? camIn.tracker : (sim.camera && sim.camera.tracker))
    && f.tp && f.tp[0];
  var fCenter = follow ? skyTpCenter(f.tp) : null;
  var camYaw = fCenter ? fCenter.az : camIn.yaw;
  var camPitch = fCenter ? Math.max(0, Math.min(90, fCenter.alt)) : camIn.pitch;
  var cam = { yaw: camYaw, pitch: camPitch, fov: fov };
  var B = skyBasis(cam, W, H);
  var mode = view.mode === 'eq' ? 'eq' : 'altaz';
  var sunAlt = typeof f.sun === 'number' ? f.sun : (sim.sky === 'day' ? 20 : -25);
  // 晨昏亮度：按太阳高度在「夜 / 暮光 / 白天」三套色板之间插值
  var pal = skyPhasePalette(sim, sunAlt);
  var starAlpha = Math.max(0, Math.min(1, (-sunAlt - 4) / 10));
  var night = sunAlt < -18;
  var dark = sunAlt < -3;
  var pxDeg = B.k * 0.5 * SKY_D2R;
  function font(px) { return Math.round(px * Math.max(1, S)) + 'px sans-serif'; }

  function mixHex(a, b, t) {
    if (!a || !b || a[0] !== '#') return b || a;
    var pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    var ar = (pa >> 16) & 255, ag = (pa >> 8) & 255, ab = pa & 255;
    var br = (pb >> 16) & 255, bg = (pb >> 8) & 255, bb = pb & 255;
    var r = Math.round(ar + (br - ar) * t), g = Math.round(ag + (bg - ag) * t), bl = Math.round(ab + (bb - ab) * t);
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1);
  }
  function skyPhasePalette(sim2, alt) {
    var base = sim2.palettes || {
      night: sim2.palette || { gradient: ['#04070f', '#0a1322', '#16233a'], ground: '#05070c', label: '#cfe0f7' },
      twilight: { gradient: ['#1b2340', '#4a3f63', '#b06a4a'], ground: '#0a0c12', label: '#ffd9a8' },
      day: { gradient: ['#3f74c9', '#7aa8e6', '#cfe0f5'], ground: '#28313a', label: '#10305c' },
    };
    var t = Math.max(0, Math.min(1, (alt + 18) / 17)); // 0 = 夜，1 = 白天
    var from = t < 0.5 ? base.night : base.twilight;
    var to = t < 0.5 ? base.twilight : base.day;
    var k = t < 0.5 ? t * 2 : (t - 0.5) * 2;
    return {
      gradient: [
        mixHex(from.gradient[0], to.gradient[0], k),
        mixHex(from.gradient[1], to.gradient[1], k),
        mixHex(from.gradient[2], to.gradient[2], k),
      ],
      ground: mixHex(from.ground, to.ground, k),
      label: k > 0.5 ? to.label : from.label,
    };
  }

  function screen(v) {
    var q = skyProject(v, B, W, H);
    return q ? { x: q.x * W, y: q.y * H } : null;
  }
  // 不裁屏幕边界的投影（多边形要用，靠 canvas 自己裁）
  function projectRaw(v) {
    var d = v[0] * B.f[0] + v[1] * B.f[1] + v[2] * B.f[2];
    if (d < 0.0001) return null;
    var den = 1 + d;
    var tx = v[0] * B.r[0] + v[1] * B.r[1] + v[2] * B.r[2];
    var ty = v[0] * B.u[0] + v[1] * B.u[1] + v[2] * B.u[2];
    return { x: 0.5 * W + B.k * tx / den, y: 0.5 * H - B.k * ty / den };
  }
  // 地形高度查表（整圈 360 点，按方位 Wrap 插值）：近景 + 远景两层
  var ridgeData = sim.ridge || [];
  var farData = sim.ridgeFar || [];
  function layerAt(data, azDeg) {
    if (data.length < 2) return -90;
    var a = ((azDeg % 360) + 360) % 360;
    var step = 360 / data.length;
    var idx = a / step;
    var i0 = Math.floor(idx) % data.length;
    var i1 = (i0 + 1) % data.length;
    var t = idx - Math.floor(idx);
    return data[i0][1] * (1 - t) + data[i1][1] * t;
  }
  // 真正的地平线 = 近景与远景的高者（远山可以从近景山脊上方露出来）
  function ridgeHeight(azDeg) {
    return Math.max(layerAt(ridgeData, azDeg), layerAt(farData, azDeg));
  }
  function visible(alt, az) { return alt > ridgeHeight(az) + 0.2; }
  function pos(ra, dec) {
    var p = skyEqToAltAz(ra, dec, f.lst, sim.lat);
    if (!visible(p.alt, p.az)) return null;
    return screen(skyVec(p.alt, p.az));
  }
  function posRaw(ra, dec) {
    var p = skyEqToAltAz(ra, dec, f.lst, sim.lat);
    return toScreen(skyVec(p.alt, p.az), p);
  }
  function toScreen(v, p) {
    var q = skyProject(v, B, W, H);
    return q ? { x: q.x * W, y: q.y * H, alt: p.alt, az: p.az } : null;
  }

  // 天空：按高度铺色（地平 0° → 22° → 65° 天顶），拖动画面时明暗跟着高度走，
  // 而不是钉死在屏幕上，避免同一个位置时深时浅
  var halfVdeg = 2 * Math.atan((H / 2) / B.k) / SKY_D2R;
  var altTop = camPitch + halfVdeg;
  var altBot = camPitch - halfVdeg;
  function skyColorIn(p, alt) {
    if (alt <= 0) return p[2];
    if (alt >= 65) return p[0];
    if (alt <= 22) return mixHex(p[2], p[1], alt / 22);
    return mixHex(p[1], p[0], (alt - 22) / 43);
  }
  function skyColorAt(alt) { return skyColorIn(pal.gradient, alt); }
  // 屏幕归一化坐标 → 方位角（度，0=北、90=东）：晨昏分条要靠它才知道这一列朝哪
  function skyAzAt(nx, ny) {
    var X = (nx - 0.5) * W;
    var Y = (0.5 - ny) * H;
    var rp = Math.sqrt(X * X + Y * Y);
    var th = 2 * Math.atan(rp / B.k);
    var phi = Math.atan2(Y, X);
    var st = Math.sin(th);
    var ct = Math.cos(th);
    var vx = ct * B.f[0] + st * (Math.cos(phi) * B.r[0] + Math.sin(phi) * B.u[0]);
    var vy = ct * B.f[1] + st * (Math.cos(phi) * B.r[1] + Math.sin(phi) * B.u[1]);
    return Math.atan2(vx, vy) / SKY_D2R;
  }
  // 晨昏：太阳在地平线下 18° 到地平线上 4° 之间，天空亮的那一侧要朝着太阳
  var twi = (f.sunAA && f.sun > -18 && f.sun < 4) ? Math.min(1, Math.max(0, (f.sun + 18) / 14)) : 0;
  if (twi > 0.02) {
    var sunAzDeg = f.sunAA[1];
    var sunP = [
      pal.gradient[0],
      mixHex(pal.gradient[1], '#8a5566', 0.5),
      mixHex(pal.gradient[2], '#e0864a', 0.8),
    ];
    var awayP = [
      mixHex(pal.gradient[0], '#05070f', 0.3),
      mixHex(pal.gradient[1], '#101728', 0.5),
      mixHex(pal.gradient[2], '#101828', 0.6),
    ];
    var skyCols = 64;
    for (var sci = 0; sci < skyCols; sci += 1) {
      var nx2 = (sci + 0.5) / skyCols;
      var facA = 0.5 * (1 + Math.cos((skyAzAt(nx2, 0.92) - sunAzDeg) * SKY_D2R));
      var wgt = facA * twi;
      var cp = [
        mixHex(awayP[0], sunP[0], wgt),
        mixHex(awayP[1], sunP[1], wgt),
        mixHex(awayP[2], sunP[2], wgt),
      ];
      var gc = ctx.createLinearGradient(0, 0, 0, H);
      for (var gi2 = 0; gi2 <= 6; gi2 += 1) {
        var t2 = gi2 / 6;
        gc.addColorStop(t2, skyColorIn(cp, altTop + (altBot - altTop) * t2));
      }
      ctx.fillStyle = gc;
      var xa = Math.floor((sci / skyCols) * W);
      var xb = sci === skyCols - 1 ? W : Math.ceil(((sci + 1) / skyCols) * W);
      ctx.fillRect(xa, 0, Math.max(1, xb - xa), H);
    }
  } else {
    var g = ctx.createLinearGradient(0, 0, 0, H);
    for (var gsi = 0; gsi <= 8; gsi += 1) {
      var gt = gsi / 8;
      g.addColorStop(gt, skyColorAt(altTop + (altBot - altTop) * gt));
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // 地平线（屏幕折线）：用于裁剪与地景
  var half = Math.min(125, fov / 2 + 30);
  var groundPts = [];
  for (var gz = camYaw - half; gz <= camYaw + half; gz += 2) {
    var qg = screen(skyVec(ridgeHeight(gz), gz));
    if (qg) groundPts.push(qg);
  }
  // 按 x 排序：极宽视场时地平线会绕过画面边缘、方位序里 x 不再单调，
  // 自交的折线做 clip 蒙版会被浏览器栅格化成一排竖条纹（180° 花屏）。
  // 排成「x 单调的函数图」后，裁剪多边形一定是简单多边形。
  groundPts.sort(function (a, b) { return a.x - b.x; });
  function clipSky() {
    if (groundPts.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(groundPts[0].x, groundPts[0].y);
    for (var i = 1; i < groundPts.length; i += 1) ctx.lineTo(groundPts[i].x, groundPts[i].y);
    // 地面线之上（y 更小）才是天空：折线两端拉到画布上方闭合
    ctx.lineTo(W + 60, -60);
    ctx.lineTo(-60, -60);
    ctx.closePath();
    ctx.clip();
  }
  // 地面（地平线以下）裁剪：地面压暗只压地面，不能压到天上的银河
  function clipGround() {
    if (groundPts.length < 2) { ctx.beginPath(); ctx.rect(0, 0, 0, 0); ctx.clip(); return; }
    ctx.beginPath();
    ctx.moveTo(groundPts[0].x, groundPts[0].y);
    for (var gi2 = 1; gi2 < groundPts.length; gi2 += 1) ctx.lineTo(groundPts[gi2].x, groundPts[gi2].y);
    ctx.lineTo(groundPts[groundPts.length - 1].x, H + 80);
    ctx.lineTo(groundPts[0].x, H + 80);
    ctx.closePath();
    ctx.clip();
  }

  // 地景：远景（远山）→ 近景（山峰/林线/水面/建筑/草甸）→ 地面渐变
  function ridgeScreen(data) {
    var pts = [];
    for (var i = 0; i < data.length; i += 1) {
      var q = screen(skyVec(data[i][1], data[i][0]));
      if (q) pts.push({ x: q.x, y: q.y, kind: data[i][2] || 0 });
    }
    pts.sort(function (a, b) { return a.x - b.x; });
    return pts;
  }
  function fillSilhouette(pts, fill, stroke) {
    if (pts.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(-20, H + 20);
    for (var j = 0; j < pts.length; j += 1) ctx.lineTo(pts[j].x, pts[j].y);
    ctx.lineTo(W + 20, H + 20);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  var farPts = ridgeScreen(farData);
  fillSilhouette(farPts, dark ? mixHex(pal.ground, '#54688c', 0.42) : 'rgba(96,116,146,.45)', null);
  var nearPts = ridgeScreen(ridgeData);
  fillSilhouette(nearPts, pal.ground, dark ? 'rgba(150,180,225,.35)' : 'rgba(20,30,45,.55)');

  // 近景只加「真实存在」的细节：林线、水面反光、建筑块。
  // 山脊高度完全来自实测高程剖面，不再往上叠人工装饰。
  var deco = dark ? 'rgba(8,12,20,.9)' : 'rgba(28,36,50,.35)';
  for (var di = 1; di < nearPts.length; di += 1) {
    var p0 = nearPts[di - 1];
    var p1 = nearPts[di];
    var dx = p1.x - p0.x;
    if (dx < 6 || dx > W * 0.5) continue;
    var midX = (p0.x + p1.x) / 2;
    var midY = Math.min(p0.y, p1.y);
    var kind = p1.kind;
    if (kind === 1) {
      // 林线：沿山脊的一条深色软带（不再是锯齿三角）
      ctx.strokeStyle = dark ? 'rgba(9,16,12,.55)' : 'rgba(34,52,38,.30)';
      ctx.lineWidth = Math.max(1.2, 2.4 * S);
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y + 1 * S);
      ctx.lineTo(p1.x, p1.y + 1 * S);
      ctx.stroke();
    } else if (kind === 2) {
      // 水面：基线加反光
      ctx.strokeStyle = dark ? 'rgba(120,170,220,.35)' : 'rgba(40,70,110,.35)';
      ctx.lineWidth = Math.max(1, 1.2 * S);
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
      var refl = ctx.createLinearGradient(0, midY, 0, midY + 14 * S);
      refl.addColorStop(0, dark ? 'rgba(90,140,200,.18)' : 'rgba(120,160,210,.22)');
      refl.addColorStop(1, 'rgba(90,140,200,0)');
      ctx.fillStyle = refl;
      ctx.fillRect(p0.x, midY, dx, 14 * S);
    } else if (kind === 4) {
      // 建筑：1–3 个方块 + 桅杆
      var blocks = Math.max(1, Math.min(3, Math.round(dx / (26 * S))));
      ctx.fillStyle = dark ? 'rgba(12,17,26,.95)' : 'rgba(30,40,56,.55)';
      for (var bi2 = 0; bi2 < blocks; bi2 += 1) {
        var bw = Math.min(12 * S, dx / (blocks + 1));
        var bh = Math.min(22 * S, 7 * S + dx * 0.12);
        var bx = p0.x + (dx * (bi2 + 0.5)) / blocks - bw / 2;
        ctx.fillRect(bx, p0.y - bh, bw, bh);
      }
      ctx.strokeStyle = deco;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(midX, midY);
      ctx.lineTo(midX, midY - 16 * S);
      ctx.stroke();
    }
  }

  // 地面压暗：只压地平线以下（clipGround），不会把天上的银河一起压暗
  var horizonY = H * 0.7;
  if (groundPts.length) {
    var hy = groundPts[0].y;
    for (var hi2 = 1; hi2 < groundPts.length; hi2 += 1) hy = Math.min(hy, groundPts[hi2].y);
    horizonY = Math.min(H + 40, hy);
  }
  var gg = ctx.createLinearGradient(0, Math.max(0, horizonY - 10 * S), 0, Math.max(horizonY + 40, H));
  gg.addColorStop(0, 'rgba(0,0,0,0)');
  gg.addColorStop(1, dark ? 'rgba(0,0,0,.55)' : 'rgba(0,0,0,.18)');
  ctx.save();
  clipGround();
  ctx.fillStyle = gg;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  // 地景名
  ctx.font = font(10);
  ctx.textAlign = 'center';
  ctx.fillStyle = dark ? 'rgba(175,200,235,.5)' : 'rgba(25,35,50,.65)';
  var fgs = sim.foregrounds || [];
  for (var fi = 0; fi < fgs.length; fi += 1) {
    var fg = fgs[fi];
    var fgAz = (fg.azFrom + (fg.azTo < fg.azFrom ? fg.azTo + 360 : fg.azTo)) / 2;
    var qfg = screen(skyVec(ridgeHeight(fgAz) + 1.6, fgAz));
    if (qfg && qfg.y < H - 6 * S && qfg.y > 8 && fg.name) ctx.fillText(fg.name, qfg.x, qfg.y);
  }

  // 方位字（东南西北）
  var CARD = [[0, '北'], [90, '东'], [180, '南'], [270, '西']];
  ctx.font = font(12);
  ctx.textAlign = 'center';
  for (var ci = 0; ci < CARD.length; ci += 1) {
    var qc = screen(skyVec(ridgeHeight(CARD[ci][0]) + 2.6, CARD[ci][0]));
    if (!qc) continue;
    ctx.fillStyle = dark ? 'rgba(200,220,250,.55)' : 'rgba(25,40,60,.7)';
    ctx.fillText(CARD[ci][1], qc.x, qc.y);
  }

  // ---- 以下全部裁剪在地景以上 ----
  ctx.save();
  clipSky();

  // 网格：地平坐标 / 赤道坐标（线上标数值）
  ctx.lineWidth = 1;
  ctx.strokeStyle = dark ? 'rgba(120,160,220,.13)' : 'rgba(30,60,110,.16)';
  var gridLabel = dark ? 'rgba(160,190,230,.62)' : 'rgba(30,60,110,.7)';
  function polyline(points) {
    var on = false;
    ctx.beginPath();
    for (var i = 0; i < points.length; i += 1) {
      var q = points[i];
      if (!q) { on = false; continue; }
      if (on) ctx.lineTo(q.x, q.y); else { ctx.moveTo(q.x, q.y); on = true; }
    }
    ctx.stroke();
  }
  function pickLabelPoint(points) {
    var best = null;
    for (var i = 0; i < points.length; i += 1) {
      var q = points[i];
      if (!q) continue;
      if (q.x < 26 * S || q.x > W - 26 * S || q.y < 30 * S || q.y > H - 14 * S) continue;
      if (!best || Math.abs(q.x - W / 2) < Math.abs(best.x - W / 2)) best = q;
    }
    return best;
  }
  function tick(q, text, align) {
    if (!q) return;
    ctx.font = font(7);
    ctx.textAlign = align || 'left';
    ctx.fillStyle = 'rgba(4,8,14,.4)';
    var w = text.length * 4.2 * S + 3 * S;
    var x = align === 'right' ? q.x - w - 2 * S : q.x + 2 * S;
    ctx.fillRect(x, q.y - 7 * S, w, 8.5 * S);
    ctx.fillStyle = gridLabel;
    ctx.fillText(text, align === 'right' ? q.x - 3 * S : q.x + 3.5 * S, q.y - 0.8 * S);
  }
  var coarse = fov > 60;
  if (mode === 'altaz') {
    var alts = coarse ? [30, 60] : [15, 30, 45, 60, 75];
    for (var ai = 0; ai < alts.length; ai += 1) {
      var ring = [];
      for (var az = 0; az <= 360; az += 3) ring.push(screen(skyVec(alts[ai], az)));
      polyline(ring);
      tick(pickLabelPoint(ring), '高度 ' + alts[ai] + '°');
    }
    var stepAz = coarse ? 45 : 15;
    for (var az2 = 0; az2 < 360; az2 += stepAz) {
      var mer = [];
      for (var alt2 = 0; alt2 <= 90; alt2 += 3) mer.push(screen(skyVec(alt2, az2)));
      polyline(mer);
      // 正方位已经在山脊上标了东南西北，这里只标其余方位
      if (az2 % 90 !== 0 && visible(12, az2)) tick(screen(skyVec(12, az2)), '方位 ' + az2 + '°');
    }
  } else {
    var decs = coarse ? [-60, -30, 0, 30, 60] : [-60, -45, -30, -15, 0, 15, 30, 45, 60];
    for (var di = 0; di < decs.length; di += 1) {
      var rr = [];
      for (var ra = 0; ra <= 360; ra += 3) rr.push(posRaw(ra, decs[di]));
      polyline(rr);
      tick(pickLabelPoint(rr), '赤纬 ' + (decs[di] >= 0 ? '+' : '') + decs[di] + '°');
    }
    var stepRa = coarse ? 30 : 15;
    for (var ra2 = 0; ra2 < 360; ra2 += stepRa) {
      var mm2 = [];
      for (var d2 = -80; d2 <= 80; d2 += 3) mm2.push(posRaw(ra2, d2));
      polyline(mm2);
      tick(pickLabelPoint(mm2), '赤经 ' + Math.round(ra2 / 15) + 'h');
    }
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = dark ? 'rgba(160,200,255,.22)' : 'rgba(30,70,130,.22)';
    var eq = [];
    for (var e2 = 0; e2 <= 360; e2 += 3) eq.push(posRaw(e2, 0));
    polyline(eq);
    ctx.restore();
  }

  // 银河：真实等值线多边形（含暗尘带），近平面裁剪后逐级叠加。
  // 用「加色」混合（lighter）：银河只在底色上做加法，任何视角下都不会比天空暗。
  // 等值线是**嵌套**的：越往里越亮，所以每一级只加「相邻两级的差」，
  // 最亮一级累计到 0.26 就停住；若每级都按自身亮度叠加，核心会叠到 0.9 变成一条白光束。
  //
  // 裁剪后的收口必须沿裁剪圆走弧线：用弦会在画面上拉出一条横穿整个天空的直线，
  // 把大片天空误填成一条浅色带。弧线朝哪边走有歧义（绕到相机背后时奇偶会翻），
  // 所以两种走法各建一次，取「画面中心的奇偶 == 相机方向是否在区域内」的那一版；
  // 两种都不对就整块丢掉，宁可少画也不糊成一片。
  var mw = meta.milkyway || [];
  if (mw.length && starAlpha > 0.05) {
    // 近平面固定在 89°：不随视场变。以前是 cos(fov/2+8°)，缩放时被裁掉的轮廓跟着变，
    // 同一片天区一会儿填一会儿不填，就成了"银河和夜空换色"。
    var mwNearD = 0.02;
    // 相机方向是否在某条环围成的球面区域内（绕数 = ±2π 即在内部）
    function mwContains(vecs) {
      var sum = 0;
      for (var i = 0; i < vecs.length; i += 1) {
        var a = vecs[i];
        var b = vecs[(i + 1) % vecs.length];
        var ax = a[0] * B.r[0] + a[1] * B.r[1] + a[2] * B.r[2];
        var ay = a[0] * B.u[0] + a[1] * B.u[1] + a[2] * B.u[2];
        var bx = b[0] * B.r[0] + b[1] * B.r[1] + b[2] * B.r[2];
        var by = b[0] * B.u[0] + b[1] * B.u[1] + b[2] * B.u[2];
        sum += Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
      }
      return Math.abs(sum) > Math.PI;
    }
    // 一条环按近平面做 Sutherland–Hodgman 裁剪 → 恰好一个闭合多边形（3D 单位矢量）。
    // 关键：裁的是"多边形内部落在相机前方的部分"，不是它的补集；交点插值后要归一化，
    // 否则下面的立体投影公式（只对单位矢量成立）会算歪。
    // 同时标出哪些顶点是落在裁剪平面上的交点 —— 它们之间要沿裁剪圆走弧，不能拉弦。
    function mwClipRing(vecs) {
      var out = [];
      var on = [];
      var n = vecs.length;
      for (var ci3 = 0; ci3 < n; ci3 += 1) {
        var v1 = vecs[ci3];
        var v2 = vecs[(ci3 + 1) % n];
        var d1 = v1[0] * B.f[0] + v1[1] * B.f[1] + v1[2] * B.f[2] - mwNearD;
        var d2 = v2[0] * B.f[0] + v2[1] * B.f[1] + v2[2] * B.f[2] - mwNearD;
        if (d1 >= 0) { out.push(v1); on.push(false); }
        if ((d1 >= 0) !== (d2 >= 0)) {
          var tt = d1 / (d1 - d2);
          var ix = v1[0] + (v2[0] - v1[0]) * tt;
          var iy = v1[1] + (v2[1] - v1[1]) * tt;
          var iz = v1[2] + (v2[2] - v1[2]) * tt;
          var il = Math.sqrt(ix * ix + iy * iy + iz * iz) || 1;
          out.push([ix / il, iy / il, iz / il]);
          on.push(true);
        }
      }
      return out.length >= 3 ? { pts: out, on: on } : null;
    }
    // 裁剪圆上的一点（phi 为相机切平面里的方位角）
    function mwArcPoint(phi) {
      var s = Math.sqrt(Math.max(0, 1 - mwNearD * mwNearD));
      return [
        mwNearD * B.f[0] + s * (Math.cos(phi) * B.r[0] + Math.sin(phi) * B.u[0]),
        mwNearD * B.f[1] + s * (Math.cos(phi) * B.r[1] + Math.sin(phi) * B.u[1]),
        mwNearD * B.f[2] + s * (Math.cos(phi) * B.r[2] + Math.sin(phi) * B.u[2]),
      ];
    }
    function mwAngleOf(v) {
      var tx = v[0] * B.r[0] + v[1] * B.r[1] + v[2] * B.r[2];
      var ty = v[0] * B.u[0] + v[1] * B.u[1] + v[2] * B.u[2];
      if (Math.abs(tx) + Math.abs(ty) < 1e-9) return 0;
      return Math.atan2(ty, tx);
    }
    // 球面绕数：方向 v 是否落在这组环围成的区域里（对多条环做 even-odd）
    function mwSphericalParity(ringsVecs, v) {
      var par = false;
      for (var r = 0; r < ringsVecs.length; r += 1) {
        var ring = ringsVecs[r];
        var sum = 0;
        for (var i = 0; i < ring.length; i += 1) {
          var a = ring[i];
          var b = ring[(i + 1) % ring.length];
          var ax = a[0] * B.r[0] + a[1] * B.r[1] + a[2] * B.r[2];
          var ay = a[0] * B.u[0] + a[1] * B.u[1] + a[2] * B.u[2];
          var bx = b[0] * B.r[0] + b[1] * B.r[1] + b[2] * B.r[2];
          var by = b[0] * B.u[0] + b[1] * B.u[1] + b[2] * B.u[2];
          sum += Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
        }
        if (Math.abs(sum) > Math.PI) par = !par;
      }
      return par;
    }
    // 屏幕奇偶：点是否落在这组子路径里（even-odd）
    function mwScreenParity(subs, px, py) {
      var par = false;
      for (var si2 = 0; si2 < subs.length; si2 += 1) {
        var p = subs[si2];
        for (var qi = 0; qi < p.length; qi += 1) {
          var a = p[qi];
          var b = p[(qi + 1) % p.length];
          if ((a[1] > py) !== (b[1] > py)) {
            var x = a[0] + ((py - a[1]) / (b[1] - a[1])) * (b[0] - a[0]);
            if (x > px) par = !par;
          }
        }
      }
      return par;
    }
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var li = 0; li < mw.length; li += 1) {
      var lvl2 = mw[li].level || 0;
      // 五级是**嵌套的环带**（每级 = 外环 − 内洞）：第 0 级是包住银河带的一圈极淡薄雾（89% 天空），
      // 越往里越亮。按真实明暗由外向内分配 alpha，逐级叠加出银河的亮度梯度。
      // 全部加色（lighter）：只会比夜空亮，不会变暗，也不会和夜空换色。
      var alpha = (lvl2 === 0 ? 0.010 : lvl2 === 1 ? 0.060 : 0.050) * starAlpha;
      ctx.fillStyle = 'rgba(206,217,242,' + alpha.toFixed(3) + ')';
      var polys2 = mw[li].polys || [];
      for (var pi4 = 0; pi4 < polys2.length; pi4 += 1) {
        var rings2 = polys2[pi4] || [];
        var ringsVecs = [];
        for (var ri2 = 0; ri2 < rings2.length; ri2 += 1) {
          var ring = rings2[ri2];
          if (ring.length < 3) continue;
          var vecs = [];
          for (var vi3 = 0; vi3 < ring.length; vi3 += 1) {
            var pav = skyEqToAltAz(ring[vi3][0], ring[vi3][1], f.lst, sim.lat);
            vecs.push(skyVec(pav.alt, pav.az));
          }
          ringsVecs.push(vecs);
        }
        if (!ringsVecs.length) continue;
        // 逐环裁剪 → 每条环一个闭环；合起来一次 even-odd 填充（洞仍是真洞）。
        // 落在裁剪平面上的两个交点之间沿裁剪圆插弧，避免拉出横穿画面的长弦（浅色带）。
        var subs = [];
        for (var rj = 0; rj < ringsVecs.length; rj += 1) {
          var clipped = mwClipRing(ringsVecs[rj]);
          if (!clipped) continue;
          var pts2 = clipped.pts;
          var onP = clipped.on;
          var loop = [];
          var bad = false;
          for (var cj = 0; cj < pts2.length; cj += 1) {
            var qc = projectRaw(pts2[cj]);
            if (!qc) { bad = true; break; }
            loop.push([qc.x, qc.y]);
            var nj = (cj + 1) % pts2.length;
            if (onP[cj] && onP[nj]) {
              var a1 = mwAngleOf(pts2[cj]);
              var a2 = mwAngleOf(pts2[nj]);
              var dp = a2 - a1;
              while (dp > Math.PI) dp -= Math.PI * 2;
              while (dp < -Math.PI) dp += Math.PI * 2;
              if (Math.abs(dp) > 0.05) {
                var steps4 = Math.ceil(Math.abs(dp) / 0.05);
                for (var sj4 = 1; sj4 < steps4; sj4 += 1) {
                  var qa4 = projectRaw(mwArcPoint(a1 + (dp * sj4) / steps4));
                  if (qa4) loop.push([qa4.x, qa4.y]);
                }
              }
            }
          }
          if (!bad && loop.length >= 3) subs.push(loop);
        }
        if (!subs.length) continue;
        // 保险丝：投影出来的奇偶必须和球面绕数一致，否则这一组会画成"补集"（就是换色），宁可不画
        var camV = B.f;
        if (mwScreenParity(subs, W / 2, H / 2) !== mwSphericalParity(ringsVecs, camV)) continue;
        ctx.beginPath();
        for (var si4 = 0; si4 < subs.length; si4 += 1) {
          var sp = subs[si4];
          ctx.moveTo(sp[0][0], sp[0][1]);
          for (var qj = 1; qj < sp.length; qj += 1) ctx.lineTo(sp[qj][0], sp[qj][1]);
          ctx.closePath();
        }
        ctx.fill('evenodd');
      }
    }
    ctx.restore();
  }

  // 黄道
  var ec = meta.ecliptic || [];
  if (ec.length > 2) {
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = dark ? 'rgba(235,190,100,.42)' : 'rgba(170,110,20,.5)';
    ctx.lineWidth = 1.2;
    var e0 = false;
    var firstE = null;
    ctx.beginPath();
    for (var ei = 0; ei < ec.length; ei += 1) {
      var qe = pos(ec[ei][0], ec[ei][1]);
      if (!qe) { e0 = false; continue; }
      if (!firstE) firstE = qe;
      if (e0) ctx.lineTo(qe.x, qe.y); else { ctx.moveTo(qe.x, qe.y); e0 = true; }
    }
    ctx.stroke();
    ctx.restore();
    if (firstE) {
      ctx.font = font(10);
      ctx.textAlign = 'left';
      ctx.fillStyle = dark ? 'rgba(235,190,100,.75)' : 'rgba(150,100,20,.8)';
      ctx.fillText('黄道', Math.min(firstE.x + 4, W - 26 * S), Math.max(firstE.y - 4, 12 * S));
    }
  }

  // 星座连线 + 星座名
  var lines = meta.lines || [];
  if (lines.length && starAlpha > 0) {
    ctx.strokeStyle = 'rgba(130,170,230,' + (0.05 + 0.12 * starAlpha).toFixed(2) + ')';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (var li = 0; li < lines.length; li += 1) {
      var paths = lines[li].paths || [];
      for (var pi = 0; pi < paths.length; pi += 1) {
        var path = paths[pi];
        var on = false;
        for (var vi = 0; vi < path.length; vi += 1) {
          var qv2 = pos(path[vi][0], path[vi][1]);
          if (!qv2) { on = false; continue; }
          if (on) ctx.lineTo(qv2.x, qv2.y); else { ctx.moveTo(qv2.x, qv2.y); on = true; }
        }
      }
    }
    ctx.stroke();
    if (fov < 80) {
      ctx.font = font(9);
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(150,185,235,' + (0.18 + 0.3 * starAlpha).toFixed(2) + ')';
      for (var cn2 = 0; cn2 < lines.length; cn2 += 1) {
        var cps = lines[cn2].paths || [];
        var sx = 0, sy = 0, sz = 0, n = 0;
        for (var cj = 0; cj < cps.length; cj += 1) {
          for (var ck = 0; ck < cps[cj].length; ck += 1) {
            var pp2 = skyEqToAltAz(cps[cj][ck][0], cps[cj][ck][1], f.lst, sim.lat);
            if (!visible(pp2.alt, pp2.az)) continue;
            var vv2 = skyVec(pp2.alt, pp2.az);
            sx += vv2[0]; sy += vv2[1]; sz += vv2[2]; n += 1;
          }
        }
        if (n < 3) continue;
        var ln = Math.hypot(sx, sy, sz);
        if (ln < 0.25) continue;
        var qcn = screen([sx / ln, sy / ln, sz / ln]);
        if (qcn && qcn.x > 12 && qcn.x < W - 12 && qcn.y > 10 && qcn.y < H - 10) {
          ctx.fillText(lines[cn2].n || '', qcn.x, qcn.y);
        }
      }
    }
  }

  // 亮星
  if (starAlpha > 0) {
    var stars = meta.stars || [];
    ctx.textAlign = 'left';
    var nameMag = fov < 55 ? 2.4 : 1.6;
    for (var si = 0; si < stars.length; si += 1) {
      var st = stars[si];
      var sp = skyEqToAltAz(st[0], st[1], f.lst, sim.lat);
      if (!visible(sp.alt, sp.az)) continue;
      var qs = screen(skyVec(sp.alt, sp.az));
      if (!qs) continue;
      var bright = Math.max(0, 4.2 - st[2]);
      var rad = Math.max(0.6, Math.min(2.8, 0.6 + bright * 0.24)) * Math.max(1, S);
      ctx.fillStyle = 'rgba(226,238,255,' + (starAlpha * (0.35 + Math.min(0.65, bright * 0.2))).toFixed(2) + ')';
      ctx.beginPath();
      ctx.arc(qs.x, qs.y, rad, 0, Math.PI * 2);
      ctx.fill();
      if (st[3] && st[2] <= nameMag) {
        ctx.font = font(9);
        ctx.fillStyle = 'rgba(200,220,250,' + (0.55 * starAlpha).toFixed(2) + ')';
        ctx.fillText(st[3], qs.x + 4 * S, qs.y - 3 * S);
      }
    }
  }

  // 行星与日月
  var names = sim.bodyNames || [];
  // 目标天体由目标标记自己画（白圈 + 名字），这里不再重复画一遍，否则木星/月球会出现两个标签
  var targetNames = (sim.targets || []).map(function (t) { return t && t.name; });
  for (var bj = 0; bj < (f.bodies || []).length; bj += 1) {
    var body = f.bodies[bj];
    var name = names[body[2]] || '';
    if (targetNames.indexOf(name) >= 0) continue;
    var qb2 = pos(body[0], body[1]);
    if (!qb2) continue;
    var sizeDeg = body[3] || 0;
    function bodyLabel(text) {
      ctx.font = font(10);
      ctx.textAlign = 'left';
      ctx.fillStyle = dark ? 'rgba(240,246,255,.9)' : 'rgba(20,40,70,.9)';
      ctx.fillText(text, qb2.x + Math.max(6 * S, (sizeDeg * 0.5 * pxDeg) + 5 * S), qb2.y - Math.max(4 * S, sizeDeg * 0.5 * pxDeg) - 2 * S);
    }
    if (name === '太阳') {
      var sr = Math.max(1.4 * S, (sizeDeg || 0.53) * 0.5 * pxDeg);
      var halo = ctx.createRadialGradient(qb2.x, qb2.y, sr * 0.6, qb2.x, qb2.y, sr * 5);
      halo.addColorStop(0, 'rgba(255,236,170,.75)');
      halo.addColorStop(1, 'rgba(255,220,120,0)');
      ctx.fillStyle = halo;
      ctx.beginPath(); ctx.arc(qb2.x, qb2.y, sr * 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff4c8';
      ctx.beginPath(); ctx.arc(qb2.x, qb2.y, sr, 0, Math.PI * 2); ctx.fill();
      bodyLabel('太阳');
    } else if (name === '月球') {
      // 月球统一由下面的 f.moon 画（带相位、只标一次名），这里直接跳过
      continue;
    } else {
      var pr = (name === '金星' || name === '木星' ? 1.9 : 1.5) * Math.max(1, S);
      ctx.fillStyle = '#fff2cf';
      ctx.beginPath(); ctx.arc(qb2.x, qb2.y, pr, 0, Math.PI * 2); ctx.fill();
      ctx.font = font(9);
      ctx.textAlign = 'left';
      ctx.fillStyle = dark ? 'rgba(255,240,200,.85)' : 'rgba(60,40,10,.85)';
      ctx.fillText(name, qb2.x + 4 * S, qb2.y - 3 * S);
    }
  }
  var moonRadiusPx = 0;
  if (f.moon) {
    var qm = pos(f.moon[0], f.moon[1]);
    if (qm) {
      var mAA = skyEqToAltAz(f.moon[0], f.moon[1], f.lst, sim.lat);
      var mr2 = Math.max(1.4 * S, (f.moon[3] || 0.52) * 0.5 * pxDeg);
      moonRadiusPx = mr2;
      var illum2 = f.moon[2] == null ? 100 : f.moon[2];
      // 月食：按食分把亮面压暗、往铜红偏（全食时是一枚暗红圆盘）
      var obsc2 = Math.max(0, Math.min(1, Number(f.moonObsc) || 0));
      // 亮面朝向太阳：在屏幕上取「月球 → 太阳」的方向角
      var theta = Math.PI / 2;
      if (f.sunAA) {
        var mv = skyVec(mAA.alt, mAA.az);
        var sv = skyVec(f.sunAA[0], f.sunAA[1]);
        var dv = [sv[0] - mv[0], sv[1] - mv[1], sv[2] - mv[2]];
        var dn = Math.sqrt(dv[0] * dv[0] + dv[1] * dv[1] + dv[2] * dv[2]);
        if (dn > 1e-6) {
          var tv = [dv[0] / dn, dv[1] / dn, dv[2] / dn];
          var nv = [mv[0] + tv[0] * 0.02, mv[1] + tv[1] * 0.02, mv[2] + tv[2] * 0.02];
          var nn = Math.sqrt(nv[0] * nv[0] + nv[1] * nv[1] + nv[2] * nv[2]);
          var p2 = projectRaw([nv[0] / nn, nv[1] / nn, nv[2] / nn]);
          var p1 = projectRaw(mv);
          if (p1 && p2) theta = Math.atan2(p2.y - p1.y, p2.x - p1.x);
        }
      }
      ctx.save();
      // 亮面：满月先铺整轮，再把背光部分用「当处天空色」盖掉，看起来就是月亮缺了一块
      ctx.globalAlpha = 0.95 - 0.4 * obsc2;
      ctx.fillStyle = obsc2 > 0 ? mixHex('#ebf2fc', '#b4553a', obsc2) : 'rgba(235,242,252,.95)';
      ctx.beginPath(); ctx.arc(qm.x, qm.y, mr2, 0, Math.PI * 2); ctx.fill();
      // 亮面那半圈的细边（随后被暗面盖住另一半）
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.lineWidth = Math.max(0.6, 0.6 * S);
      ctx.beginPath(); ctx.arc(qm.x, qm.y, mr2, 0, Math.PI * 2); ctx.stroke();
      var frac = Math.max(0, Math.min(1, illum2 / 100));
      if (frac < 0.995) {
        var kk = 1 - 2 * frac;             // +1 新月 → -1 满月
        var cR = Math.cos(theta), sR = Math.sin(theta);
        var px2 = function (lx, ly) { return qm.x + lx * cR - ly * sR; };
        var py2 = function (lx, ly) { return qm.y + lx * sR + ly * cR; };
        ctx.globalAlpha = 0.94;
        ctx.fillStyle = skyColorAt(mAA.alt);
        ctx.beginPath();
        // 背光半圆（局部 -x 侧）：从 (0,-R) 经 (-R,0) 到 (0,R)
        var seg = 24;
        for (var si5 = 0; si5 <= seg; si5 += 1) {
          var a5 = Math.PI / 2 + (Math.PI * si5) / seg;
          var lx5 = mr2 * Math.cos(a5), ly5 = mr2 * Math.sin(a5);
          if (si5 === 0) ctx.moveTo(px2(lx5, ly5), py2(lx5, ly5));
          else ctx.lineTo(px2(lx5, ly5), py2(lx5, ly5));
        }
        // 晨昏线：x = k·R·sin(u)，y = R·cos(u)；从 (0,−R) 回到 (0,R)
        for (var si6 = seg; si6 >= 0; si6 -= 1) {
          var u6 = (Math.PI * si6) / seg;
          var lx6 = kk * mr2 * Math.sin(u6), ly6 = mr2 * Math.cos(u6);
          ctx.lineTo(px2(lx6, ly6), py2(lx6, ly6));
        }
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      ctx.font = font(10);
      ctx.textAlign = 'left';
      ctx.fillStyle = dark ? 'rgba(240,246,255,.9)' : 'rgba(20,40,70,.9)';
      ctx.fillText('月球', qm.x + Math.max(6 * S, mr2 + 5 * S), qm.y - mr2 - 2 * S);
    }
  }

  // 彗星与彗尾
  if (f.comet) {
    var qh2 = pos(f.comet.head[0], f.comet.head[1]);
    var qt = pos(f.comet.tip[0], f.comet.tip[1]);
    if (qh2) {
      if (qt) {
        var dx = qt.x - qh2.x, dy = qt.y - qh2.y;
        var len = Math.hypot(dx, dy) || 1;
        var nx = -dy / len, ny = dx / len;
        var tailGrad = ctx.createLinearGradient(qh2.x, qh2.y, qt.x, qt.y);
        tailGrad.addColorStop(0, 'rgba(170,230,255,.75)');
        tailGrad.addColorStop(1, 'rgba(120,190,255,0)');
        ctx.fillStyle = tailGrad;
        ctx.beginPath();
        ctx.moveTo(qh2.x + nx * 1.6 * S, qh2.y + ny * 1.6 * S);
        ctx.lineTo(qt.x + nx * 5 * S, qt.y + ny * 5 * S);
        ctx.lineTo(qt.x - nx * 5 * S, qt.y - ny * 5 * S);
        ctx.lineTo(qh2.x - nx * 1.6 * S, qh2.y - ny * 1.6 * S);
        ctx.closePath();
        ctx.fill();
      }
      var ch = ctx.createRadialGradient(qh2.x, qh2.y, 0, qh2.x, qh2.y, 9 * S);
      ch.addColorStop(0, 'rgba(210,245,255,.95)');
      ch.addColorStop(1, 'rgba(150,220,255,0)');
      ctx.fillStyle = ch;
      ctx.beginPath(); ctx.arc(qh2.x, qh2.y, 9 * S, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#eafaff';
      ctx.beginPath(); ctx.arc(qh2.x, qh2.y, 2.2 * S, 0, Math.PI * 2); ctx.fill();
    }
  }

  // 流星
  for (var mi = 0; mi < (f.meteors || []).length; mi += 1) {
    var m = f.meteors[mi];
    var a1 = pos(m[0], m[1]);
    var a2 = pos(m[2], m[3]);
    if (!a1 || !a2) continue;
    ctx.strokeStyle = 'rgba(255,236,190,' + Math.max(0.12, m[4]).toFixed(2) + ')';
    ctx.lineWidth = 1.4 * Math.max(1, S);
    ctx.beginPath();
    ctx.moveTo(a1.x, a1.y);
    ctx.lineTo(a2.x, a2.y);
    ctx.stroke();
  }

  // 辐射点
  if (sim.radiant) {
    var qr2 = pos(sim.radiant[0], sim.radiant[1]);
    if (qr2) {
      ctx.strokeStyle = 'rgba(255,215,120,.85)';
      ctx.lineWidth = 1;
      var cr = 6 * S;
      ctx.beginPath();
      ctx.moveTo(qr2.x - cr, qr2.y); ctx.lineTo(qr2.x + cr, qr2.y);
      ctx.moveTo(qr2.x, qr2.y - cr); ctx.lineTo(qr2.x, qr2.y + cr);
      ctx.stroke();
      ctx.font = font(9);
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(255,215,120,.85)';
      ctx.fillText('辐射点', qr2.x + 7 * S, qr2.y - 5 * S);
    }
  }

  // 目标与取景框
  var tmeta = sim.targets || [];
  for (var ti = 0; ti < (f.tp || []).length; ti += 1) {
    var t = f.tp[ti];
    var qt2 = pos(t[0], t[1]);
    if (!qt2) continue;
    var tm = tmeta[ti] || {};
    var kind = tm.kind || 'point';
    var tr = kind === 'moon' || kind === 'sun' ? Math.max(4, 0.26 * pxDeg)
      : (kind === 'deepsky' || kind === 'milkyway' || kind === 'glow') ? Math.max(6, Math.min(26, (tm.sizeDeg || 2) * pxDeg))
        : 3.4;
    if (kind === 'deepsky') {
      // 深空目标本身就是一团光，画个柔光点当标记
      var glow2 = ctx.createRadialGradient(qt2.x, qt2.y, 0, qt2.x, qt2.y, tr);
      glow2.addColorStop(0, 'rgba(200,220,255,.5)');
      glow2.addColorStop(1, 'rgba(170,200,255,0)');
      ctx.fillStyle = glow2;
      ctx.beginPath(); ctx.arc(qt2.x, qt2.y, tr, 0, Math.PI * 2); ctx.fill();
    } else if (kind === 'milkyway' || kind === 'glow') {
      // 银河 / 黄道光（以及任何 glow 类目标）不画中心光晕：
      // 它们的「目标点」只是构图中心，画成一团光就成了取景框正中一团光晕。只留取景框与名字。
    } else if (kind === 'moon') {
      // 月球只画一圈定位环：实心白盘会把晨昏线（相位）盖成满月
      var ringR = Math.max((moonRadiusPx || tr) + 6 * S, 10 * S);
      ctx.strokeStyle = 'rgba(255,255,255,.5)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(qt2.x, qt2.y, ringR, 0, Math.PI * 2); ctx.stroke();
      tr = ringR;
    } else if (kind !== 'comet') {
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(qt2.x, qt2.y, tr + 3, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.95)';
      ctx.beginPath(); ctx.arc(qt2.x, qt2.y, tr, 0, Math.PI * 2); ctx.fill();
    }
    if (tm.name && ti === 0 && kind !== 'comet') {
      ctx.font = font(10);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(tm.name, qt2.x + tr + 6, qt2.y - tr - 2);
    }
  }

  // 取景框：以「所有目标的包围盒中心」为心（合时就是两颗的中点），
  // 尺寸取 max(镜头视场, 包住所有目标 + 各自视半径 + 20% 余量)，保证两颗都在框内。
  // 这里不看地景遮挡（pos 会滤掉地平线下 / 被山挡住的点），否则一颗被挡住时框就只剩另一颗了。
  if (sim.camera && sim.camera.fovH) {
    var boxPts = [];
    var maxRad = 0;
    for (var ti4 = 0; ti4 < (f.tp || []).length; ti4 += 1) {
      var aa4 = skyEqToAltAz(f.tp[ti4][0], f.tp[ti4][1], f.lst, sim.lat);
      var q4 = screen(skyVec(aa4.alt, aa4.az));
      if (q4) boxPts.push(q4);
      var tmeta4 = (sim.targets || [])[ti4] || {};
      maxRad = Math.max(maxRad, (tmeta4.sizeDeg || 0.5) * 0.5 * pxDeg);
    }
    if (boxPts.length) {
      var bx0 = boxPts[0].x, bx1 = boxPts[0].x, by0 = boxPts[0].y, by1 = boxPts[0].y;
      for (var bi4 = 1; bi4 < boxPts.length; bi4 += 1) {
        bx0 = Math.min(bx0, boxPts[bi4].x); bx1 = Math.max(bx1, boxPts[bi4].x);
        by0 = Math.min(by0, boxPts[bi4].y); by1 = Math.max(by1, boxPts[bi4].y);
      }
      var bcx = (bx0 + bx1) / 2, bcy = (by0 + by1) / 2;
      var bw = Math.max(sim.camera.fovH * pxDeg, (bx1 - bx0) * 1.2 + maxRad * 2.6 + 8 * S);
      var bh = Math.max(sim.camera.fovV * pxDeg, (by1 - by0) * 1.2 + maxRad * 2.6 + 8 * S);
      ctx.strokeStyle = 'rgba(255,255,255,.85)';
      ctx.lineWidth = 1;
      ctx.strokeRect(bcx - bw / 2, bcy - bh / 2, bw, bh);
      ctx.font = font(9);
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(255,255,255,.7)';
      ctx.fillText((sim.camera.focal || '') + 'mm', bcx - bw / 2 + 2 * S, bcy - bh / 2 - 3 * S);
    }
  }

  ctx.restore(); // 结束天空裁剪

  // HUD：加半透明底衬，白天/暮光/夜间都可读
  var hudDark = sunAlt < -3;
  var hud = hudDark ? '#e8f0ff' : '#0d2747';
  var hudDim = hudDark ? 'rgba(205,222,248,.78)' : 'rgba(20,45,80,.78)';
  function chip(x, y, w, h, a) {
    ctx.fillStyle = 'rgba(4,8,14,' + a + ')';
    ctx.fillRect(x, y, w, h);
  }
  ctx.textAlign = 'left';
  ctx.font = font(13);
  var timeText = (f.d ? f.d + ' ' : '') + f.t;
  var inWin = f.w === 1;
  var phaseText = sunAlt >= -0.8 ? '白天' : (sunAlt >= -6 ? '民用晨昏' : (sunAlt >= -18 ? '天文晨昏' : '夜间'));
  var leftTop = timeText + (inWin ? ' · 最佳时段内' : ' · 时段外');
  var topW = ctx.measureText ? ctx.measureText(leftTop).width : leftTop.length * 8 * S;
  chip(4 * S, 3 * S, Math.min(W - 8 * S, topW + 12 * S), 19 * S, 0.42);
  ctx.fillStyle = hud;
  ctx.fillText(leftTop, 9 * S, 17 * S);

  ctx.textAlign = 'right';
  ctx.font = font(11);
  var rightTop = phaseText + ' · ' + (mode === 'eq' ? '赤道坐标' : '地平坐标') + ' · 视野 ' + Math.round(fov) + '°';
  var rtW = ctx.measureText ? ctx.measureText(rightTop).width : rightTop.length * 7 * S;
  chip(Math.max(4 * S, W - rtW - 13 * S), 3 * S, Math.min(W - 8 * S, rtW + 10 * S), 19 * S, 0.42);
  ctx.fillStyle = hudDim;
  ctx.fillText(rightTop, W - 9 * S, 17 * S);

  if (f.tp && f.tp[0]) {
    var alt = f.tp[0][2];
    var az = f.tp[0][3];
    var lines2 = ['高度角 ' + alt.toFixed(0) + '° · 方位角 ' + az.toFixed(0) + '°'];
    if (mode === 'eq') lines2.push('赤经 ' + skyFmtRa(f.tp[0][0]) + ' · 赤纬 ' + (f.tp[0][1] >= 0 ? '+' : '') + f.tp[0][1].toFixed(1) + '°');
    lines2.push('北纬 ' + Math.abs(sim.lat).toFixed(2) + '° · 东经 ' + Math.abs(sim.lon).toFixed(2) + '°');
    var boxH = (lines2.length * 14 + 6) * S;
    chip(4 * S, H - boxH - 4 * S, Math.min(W * 0.62, 190 * S), boxH, 0.42);
    ctx.textAlign = 'left';
    for (var hh2 = 0; hh2 < lines2.length; hh2 += 1) {
      ctx.font = hh2 === 0 ? font(12) : font(10.5);
      ctx.fillStyle = hh2 === 0 ? hud : hudDim;
      ctx.fillText(lines2[hh2], 9 * S, H - (10 + (lines2.length - 1 - hh2) * 14) * S);
    }
  }
  var trackerOn = Boolean(camIn.tracker != null ? camIn.tracker : (sim.camera && sim.camera.tracker));
  if (trackerOn) {
    ctx.textAlign = 'right';
    ctx.font = font(10.5);
    ctx.fillStyle = hudDim;
    ctx.fillText(follow ? '跟随目标 · 滚轮缩放' : '跟踪已暂停 · 滚轮缩放', W - 9 * S, H - 8 * S);
  }
  if (sim.window) {
    ctx.textAlign = 'center';
    ctx.font = font(10);
    ctx.fillStyle = hudDim;
    ctx.fillText('最佳时段 ' + sim.window.start + ' – ' + sim.window.end, W / 2, H - 6 * S);
  }
}
`;
