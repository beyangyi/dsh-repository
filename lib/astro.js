/**
 * dsh-astro-plan — 天文计算适配层。
 *
 * 底层星历使用 vendored 的 astronomy-engine v2.1.19（MIT，见 lib/vendor）。
 * 本层只做三件事：统一时区（中国 UTC+8）、统一站点观测者、把「地平坐标 /
 * 升落 / 暮光 / 月相」包装成规划器好用的形状。
 *
 * 精度约定（与 astropy 基准对照，见 tests/astro.test.js）：
 *   - 太阳/行星高度方位：≤0.05°
 *   - 月亮（含视差）：≤0.4°（受月球理论差异限制，规划足够）
 *   - 暮光 / 月升落：≤2 min
 *   - 月照度：≤2%
 */

import * as A from './vendor/astronomy-engine.js'

const D2R = Math.PI / 180
const R2D = 180 / Math.PI
export const TZ_OFFSET_HOURS = 8

export { A }

/** Date | ISO 字符串 → AstroTime。 */
export function makeTime(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`invalid date: ${value}`)
  return A.MakeTime(date)
}

/** 站点 → astronomy-engine Observer。 */
export function observerOf(site) {
  return new A.Observer(site.lat, site.lon, site.altM ?? 0)
}

/** 把 "YYYY-MM-DD" + "HH:MM" 解析成 UTC+8 的 Date。 */
export function localDate(dateStr, hhmm = '00:00') {
  const [y, m, d] = String(dateStr).split('-').map(Number)
  const [hh, mm] = String(hhmm).split(':').map(Number)
  return new Date(Date.UTC(y, m - 1, d, hh - TZ_OFFSET_HOURS, mm || 0))
}

/** Date → UTC+8 本地 "YYYY-MM-DD"。 */
export function localDateString(date) {
  const t = new Date(date.getTime() + TZ_OFFSET_HOURS * 3600 * 1000)
  return t.toISOString().slice(0, 10)
}

/** Date → UTC+8 本地 "HH:MM"。 */
export function localHHMM(date) {
  const t = new Date(date.getTime() + TZ_OFFSET_HOURS * 3600 * 1000)
  return t.toISOString().slice(11, 16)
}

/** Date → UTC+8 本地 "YYYY-MM-DD HH:MM"（跨零点的观测窗口用这个才不歧义）。 */
export function localDateTime(date) {
  const t = new Date(date.getTime() + TZ_OFFSET_HOURS * 3600 * 1000)
  return `${t.toISOString().slice(0, 10)} ${t.toISOString().slice(11, 16)}`
}

/** Date → UTC+8 本地 "MM-DD HH:MM"（表格里用短格式，省宽度）。 */
export function localShortDateTime(date) {
  const t = new Date(date.getTime() + TZ_OFFSET_HOURS * 3600 * 1000)
  return `${t.toISOString().slice(5, 10)} ${t.toISOString().slice(11, 16)}`
}

/** 地方恒星时（小时，0–24），lon 为东经度。 */
export function lstHours(time, lonDeg) {
  const gast = A.SiderealTime(time) // 小时
  return ((gast + lonDeg / 15) % 24 + 24) % 24
}

/** 大气折射（度），地平线以上才加，避免地平线下出现假抬升。 */
function refracted(altDeg) {
  if (altDeg < -1) return altDeg
  return altDeg + A.Refraction('normal', altDeg)
}

/**
 * 时角法高度方位（快，供固定恒星批量计算）。
 * @param {number} raDeg 赤经（J2000，度）
 * @param {number} decDeg 赤纬（度）
 * @param {number} lstH 地方恒星时（小时）
 * @param {number} latDeg 站点纬度
 */
export function altAzFromHA(raDeg, decDeg, lstH, latDeg) {
  const H = ((((lstH * 15 - raDeg) % 360) + 540) % 360 - 180) * D2R
  const phi = latDeg * D2R
  const dec = decDeg * D2R
  const sinAlt = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)
  const altGeo = Math.asin(Math.max(-1, Math.min(1, sinAlt)))
  // 方位必须用「几何高度」求，折射只影响高度，否则会引入约 0.5° 的方位偏差
  const cosA = (Math.sin(dec) - Math.sin(altGeo) * Math.sin(phi)) / (Math.cos(altGeo) * Math.cos(phi) || 1e-9)
  let az = Math.acos(Math.max(-1, Math.min(1, cosA)))
  if (Math.sin(H) > 0) az = 2 * Math.PI - az
  const altDeg = altGeo * R2D
  return { alt: altDeg + (altDeg > -1 ? A.Refraction('normal', altDeg) : 0), az: (az * R2D + 360) % 360 }
}

/** J2000 星表坐标 → 当日赤道坐标（岁差），用于时角快速算法。 */
export function ofDateRADec(raDeg, decDeg, time) {
  const v = {
    x: Math.cos(decDeg * D2R) * Math.cos(raDeg * D2R),
    y: Math.cos(decDeg * D2R) * Math.sin(raDeg * D2R),
    z: Math.sin(decDeg * D2R),
    t: time,
  }
  const eqd = A.RotateVector(A.Rotation_EQJ_EQD(time), v)
  const sph = A.EquatorFromVector(eqd)
  return { raDeg: sph.ra * 15, dec: sph.dec }
}
/** 固定恒星（J2000 坐标）→ 地平坐标，矩阵法（更准，单点用）。 */
export function starAltAz(raDeg, decDeg, time, site) {
  const obs = observerOf(site)
  const v = { x: Math.cos(decDeg * D2R) * Math.cos(raDeg * D2R), y: Math.cos(decDeg * D2R) * Math.sin(raDeg * D2R), z: Math.sin(decDeg * D2R) }
  const hor = A.RotateVector(A.Rotation_EQJ_HOR(time, obs), v)
  const sph = A.HorizonFromVector(hor, null)
  return { alt: refracted(sph.lat), az: (sph.lon + 360) % 360 }
}

/** 太阳/月亮/行星 → 地平坐标（含视差与折射）。 */
export function bodyAltAz(bodyName, time, site) {
  const body = A.Body[bodyName]
  if (body === undefined) throw new Error(`unknown body: ${bodyName}`)
  const obs = observerOf(site)
  const v = A.GeoVector(body, time, true)
  const ov = A.ObserverVector(time, obs, false)
  const topo = { x: v.x - ov.x, y: v.y - ov.y, z: v.z - ov.z, t: v.t }
  const hor = A.RotateVector(A.Rotation_EQJ_HOR(time, obs), topo)
  const sph = A.HorizonFromVector(hor, null)
  return { alt: refracted(sph.lat), az: (sph.lon + 360) % 360 }
}

/**
 * 任意「地心赤道 J2000 矢量」→ 地平坐标（含视差与折射）。
 * 彗星等没有内建星历的天体走这里，与 bodyAltAz 完全同一条几何链路。
 */
export function vectorAltAz(vec, time, site) {
  const obs = observerOf(site)
  const ov = A.ObserverVector(time, obs, false)
  const topo = { x: vec.x - ov.x, y: vec.y - ov.y, z: vec.z - ov.z, t: vec.t ?? time }
  const hor = A.RotateVector(A.Rotation_EQJ_HOR(time, obs), topo)
  const sph = A.HorizonFromVector(hor, null)
  return { alt: refracted(sph.lat), az: (sph.lon + 360) % 360 }
}

/** 目标（星表或行星）→ 地平坐标，统一入口。 */
export function targetAltAz(target, time, site) {
  if (target.body) return bodyAltAz(target.body, time, site)
  return starAltAz(target.raH * 15, target.dec, time, site)
}

/** 下一次升/落（direction: +1 升, -1 落），返回 Date 或 null。 */
export function riseSet(bodyName, time, site, direction, limitDays = 2) {
  const body = A.Body[bodyName]
  if (body === undefined) throw new Error(`unknown body: ${bodyName}`)
  const found = A.SearchRiseSet(body, observerOf(site), direction, time, limitDays, 0)
  return found ? found.date : null
}

/** 太阳高度 → 下一次穿越目标高度的时刻。 */
export function searchSunAltitude(time, site, altitudeDeg, direction, limitDays = 1) {
  const found = A.SearchAltitude(A.Body.Sun, observerOf(site), direction, time, limitDays, altitudeDeg)
  return found ? found.date : null
}

/** 月相角（0=新月, 180=满月）。 */
export function moonPhaseAngle(time) {
  return A.MoonPhase(time)
}

/** 月面照度百分比。 */
export function moonIllumPercent(time) {
  const angle = A.MoonPhase(time)
  return ((1 - Math.cos(angle * D2R)) / 2) * 100
}

/** 月相名（中文）。 */
export function moonPhaseName(illum, waxing) {
  if (illum < 1.5) return '新月'
  if (illum < 12) return waxing ? '娥眉月' : '残月'
  if (illum < 45) return waxing ? '上弦前' : '下弦后'
  if (illum < 55) return '弦月'
  if (illum < 88) return waxing ? '盈凸月' : '亏凸月'
  if (illum < 98.5) return '近满月'
  return '满月'
}

/** 两个地平坐标的角距（度）。 */
export function separation(alt1, az1, alt2, az2) {
  const a1 = alt1 * D2R; const a2 = alt2 * D2R
  const dz = (az1 - az2) * D2R
  const c = Math.sin(a1) * Math.sin(a2) + Math.cos(a1) * Math.cos(a2) * Math.cos(dz)
  return Math.acos(Math.max(-1, Math.min(1, c))) * R2D
}

/** 罗盘方位名。 */
export function azName(az) {
  const names = ['北', '东北', '东', '东南', '南', '西南', '西', '西北']
  return names[Math.round(((az % 360) + 360) % 360 / 45) % 8]
}

/**
 * 一"夜"的上下文：夜定义为 D 日 15:00 → D+1 09:00（UTC+8）。
 * @param {object} site 站点
 * @param {string} dateStr "YYYY-MM-DD"
 * @param {{fast?: boolean}} [options] fast=true 时只算暮光与月相（检索路径用，
 *   省掉 4 次太阳升落搜索与 2 次月升落搜索，长跨度检索可快近一倍）
 */
export function nightContext(site, dateStr, options = {}) {
  const fast = options.fast === true
  const start = makeTime(localDate(dateStr, '15:00'))
  const endDate = localDate(dateStr, '09:00')
  endDate.setUTCDate(endDate.getUTCDate() + 1)
  const end = makeTime(endDate)

  const sunset = fast ? null : searchSunAltitude(start, site, -0.833, -1)
  const dusk = searchSunAltitude(start, site, -18, -1)
  const dawn = dusk ? searchSunAltitude(makeTime(dusk), site, -18, +1) : null
  const sunrise = fast || !dawn ? null : searchSunAltitude(makeTime(dawn), site, -0.833, +1)

  const moonrise = fast ? null : riseSet('Moon', start, site, +1)
  const moonset = fast ? null : riseSet('Moon', start, site, -1)
  const noon = makeTime(localDate(dateStr, '22:00'))
  const illum = moonIllumPercent(noon)
  const phaseAngle = moonPhaseAngle(noon)
  const waxing = phaseAngle < 180

  return {
    date: dateStr,
    start: start.date,
    end: end.date,
    sunset: sunset ? sunset : null,
    dusk: dusk ? dusk : null,
    dawn: dawn ? dawn : null,
    sunrise: sunrise ? sunrise : null,
    moonrise: moonrise && moonrise <= end.date ? moonrise : null,
    moonset: moonset && moonset <= end.date ? moonset : null,
    moonIllum: illum,
    moonPhase: moonPhaseName(illum, waxing),
    waxing,
  }
}
