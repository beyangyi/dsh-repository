/**
 * dsh-astro-plan — 天象事件层（全部按星历现算，不手抄日期）。
 *
 * 为什么现算：手写事件表曾出现「木星冲 2027-02-11」（实际 2026-07-29）、
 * 「2026-08-28 月食国内可见」（实际峰值在北京时间正午）这类错误。
 * 这里把日食 / 月食 / 冲日 / 合 / 大距全部交给 vendored astronomy-engine，
 * 只额外做「本站是否看得见」的判断。
 *
 * API 形状（给 planner 用）：
 *   lunarEclipsesBetween(from, to)   → [{id, kind, label, peakUtc, obscuration, phaseMinutes}]
 *   solarEclipsesBetween(from, to)   → [{id, kind, label, peakUtc, latitude, longitude}]
 *   planetEventsBetween(from, to)    → [{id, type:'opposition'|'conjunction'|'elongation', ...}]
 *   lunarCircumstances(site, eclipse) / localSolarCircumstances(site, eclipse)
 *   nextEclipseAfter(iso)            → 用于「下一次是 …」提示
 */

import * as astro from './astro.js'

const A = astro.A
const DAY = 86400000

export const LUNAR_LABEL = { total: '月全食', partial: '月偏食', penumbral: '半影月食' }
export const SOLAR_LABEL = { total: '日全食', annular: '日环食', partial: '日偏食' }
export const PLANET_CN = {
  Mercury: '水星', Venus: '金星', Mars: '火星', Jupiter: '木星', Saturn: '土星',
  Uranus: '天王星', Neptune: '海王星',
}

function utcDay(date) {
  return new Date(date).toISOString().slice(0, 10)
}

/** 月食名称（带食分）：月全食（食分 100%）/ 月偏食（食分 33%）/ 半影月食 */
export function lunarLabel(eclipse) {
  const obsc = Math.round(clamp01(eclipse.obscuration ?? 0) * 100)
  if (eclipse.kind === 'total') return `月全食（食分 ${obsc}%）`
  if (eclipse.kind === 'partial') return `月偏食（食分 ${obsc}%）`
  return '半影月食'
}

/**
 * 站点只看到部分阶段（月出/月落打断）时的名称：
 * 不在「全食可见区」就降级成偏食，并保留食分；全食被打断时额外注明「仅见部分阶段」，
 * 避免出现「月偏食（食分 100%）」这种让读者摸不着头脑的写法。
 */
export function lunarPartialLabel(eclipse) {
  const obsc = Math.round(clamp01(eclipse.obscuration ?? 0) * 100)
  if (eclipse.kind === 'penumbral') return '半影月食（仅见部分阶段）'
  if (eclipse.kind === 'total') return `月偏食（食分 ${obsc}%，仅见部分阶段）`
  return `月偏食（食分 ${obsc}%）`
}

function clamp01(v) {
  return Math.max(0, Math.min(1, Number(v) || 0))
}

/* ------------------------------------------------------------------ 月食 */

function shapeLunar(info) {
  const peak = info.peak.date
  const phaseMinutes = info.kind === 'total'
    ? info.sd_total
    : (info.kind === 'partial' ? info.sd_partial : info.sd_penum)
  return {
    id: `lunar-${utcDay(peak)}`,
    type: 'lunar',
    kind: info.kind,
    label: LUNAR_LABEL[info.kind] ?? '月食',
    peakUtc: peak.toISOString(),
    obscuration: info.obscuration,
    phaseMinutes: Math.max(1, Math.round(phaseMinutes)),
    penumbralMinutes: Math.round(info.sd_penum),
  }
}

/** [from, to] 内的全部月食（含半影食）。 */
export function lunarEclipsesBetween(fromISO, toISO) {
  const from = new Date(fromISO)
  const to = new Date(toISO)
  const out = []
  let info
  try {
    info = A.SearchLunarEclipse(astro.makeTime(from))
  } catch (error) {
    return out
  }
  for (let i = 0; i < 16 && info; i += 1) {
    const peak = info.peak.date
    if (peak > to) break
    if (peak >= from) out.push(shapeLunar(info))
    try {
      info = A.NextLunarEclipse(info.peak)
    } catch (error) {
      break
    }
  }
  return out
}

/**
 * 某站点看这次月食的情况：峰值时刻月亮是否在地平线上、本影阶段起止。
 * @returns {{visible:boolean, altPeak:number, azPeak:number, start:Date, end:Date}}
 */
export function lunarCircumstances(site, eclipse) {
  const peak = new Date(eclipse.peakUtc)
  const pos = astro.bodyAltAz('Moon', astro.makeTime(peak), site)
  const half = (eclipse.phaseMinutes * 60000)
  return {
    visible: pos.alt > 0,
    altPeak: pos.alt,
    azPeak: pos.az,
    start: new Date(peak.getTime() - half),
    end: new Date(peak.getTime() + half),
  }
}

/* ------------------------------------------------------------------ 日食 */

function shapeSolar(info) {
  const peak = info.peak.date
  return {
    id: `solar-${utcDay(peak)}`,
    type: 'solar',
    kind: info.kind,
    label: SOLAR_LABEL[info.kind] ?? '日食',
    peakUtc: peak.toISOString(),
    latitude: info.latitude,
    longitude: info.longitude,
    obscuration: info.obscuration,
  }
}

/** [from, to] 内的全部日食（全球范围，需再用 localSolarCircumstances 判本站）。 */
export function solarEclipsesBetween(fromISO, toISO) {
  const from = new Date(fromISO)
  const to = new Date(toISO)
  const out = []
  let info
  try {
    info = A.SearchGlobalSolarEclipse(astro.makeTime(from))
  } catch (error) {
    return out
  }
  for (let i = 0; i < 16 && info; i += 1) {
    const peak = info.peak.date
    if (peak > to) break
    if (peak >= from) out.push(shapeSolar(info))
    try {
      info = A.NextGlobalSolarEclipse(info.peak)
    } catch (error) {
      break
    }
  }
  return out
}

/**
 * 某站点看这次日食的本地情形。
 *
 * 注意：SearchLocalSolarEclipse 返回的是「该观测者下一次能看到的日食」，
 * 不一定是要查的那一次，所以必须从目标峰值往前 2 天起搜并校验峰值日期。
 * 返回的 peak / partial_begin 是 EclipseEvent { time, altitude }，不是 AstroTime。
 */
export function localSolarCircumstances(site, eclipse) {
  const target = new Date(eclipse.peakUtc)
  const probe = new Date(target.getTime() - 2 * DAY)
  let info
  try {
    info = A.SearchLocalSolarEclipse(astro.makeTime(probe), astro.observerOf(site))
  } catch (error) {
    return { visible: false, reason: 'search_failed' }
  }
  const peak = info.peak.time.date
  if (Math.abs(peak.getTime() - target.getTime()) > DAY) {
    return { visible: false, reason: 'other_eclipse' }
  }
  const altPeak = info.peak.altitude
  return {
    visible: altPeak > 0,
    reason: altPeak > 0 ? null : 'sun_below_horizon',
    kind: info.kind,
    label: SOLAR_LABEL[info.kind] ?? '日食',
    obscuration: info.obscuration,
    altPeak,
    peak,
    begin: info.partial_begin.time.date,
    end: info.partial_end.time.date,
    totalBegin: info.total_begin ? info.total_begin.time.date : null,
    totalEnd: info.total_end ? info.total_end.time.date : null,
  }
}

/* ------------------------------------------------------- 行星：冲日 / 合 / 大距 */

/** 黄经差归一到 [-180, 180)，0 表示「合」。 */
function relativeLongitude(a, b, ms) {
  const raw = A.PairLongitude(A.Body[a], A.Body[b], new Date(ms))
  return raw > 180 ? raw - 360 : raw
}

/** 两个天体的真实角距（度），用于「合」的描述。 */
function angularSeparation(a, b, ms) {
  const va = A.GeoVector(A.Body[a], astro.makeTime(new Date(ms)), true)
  const vb = A.GeoVector(A.Body[b], astro.makeTime(new Date(ms)), true)
  const dot = va.x * vb.x + va.y * vb.y + va.z * vb.z
  const na = Math.hypot(va.x, va.y, va.z)
  const nb = Math.hypot(vb.x, vb.y, vb.z)
  const cos = Math.max(-1, Math.min(1, dot / (na * nb)))
  return Math.acos(cos) * 180 / Math.PI
}

/** 在 [ms1, ms2] 内用二分法把黄经差过零点收敛到 1 分钟内。 */
function refineCrossing(a, b, ms1, ms2) {
  let lo = ms1
  let hi = ms2
  const loSign = Math.sign(relativeLongitude(a, b, lo))
  for (let i = 0; i < 30 && hi - lo > 60000; i += 1) {
    const mid = (lo + hi) / 2
    if (Math.sign(relativeLongitude(a, b, mid)) === loSign) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

const OPPOSITION_BODIES = ['Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune']
const CONJUNCTION_BODIES = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn']
/** 合相命名与取景以亮星为先：金星 > 木星 > 土星 > 火星 > 水星 */
const BRIGHTNESS_ORDER = { Venus: 0, Jupiter: 1, Saturn: 2, Mars: 3, Mercury: 4 }

/** 冲日：行星与太阳黄经相差 180°。astronomy-engine 用「日心黄经差 0」表示冲日。 */
function oppositionsBetween(from, to) {
  const out = []
  for (const body of OPPOSITION_BODIES) {
    let t = astro.makeTime(from)
    for (let i = 0; i < 8; i += 1) {
      let found
      try {
        // targetRelLon = 0 → 地球与行星同一日心黄经 → 冲日（180 是上合，行星在太阳背后）
        found = A.SearchRelativeLongitude(A.Body[body], 0, t)
      } catch (error) {
        break
      }
      const when = found.date
      if (when > to) break
      out.push({
        id: `opp-${body.toLowerCase()}-${utcDay(when)}`,
        type: 'opposition',
        body,
        objects: [body],
        utc: when.toISOString(),
        label: `${PLANET_CN[body] ?? body}冲日`,
        note: `${PLANET_CN[body] ?? body}冲日，整夜可见，视直径最大`,
      })
      t = astro.makeTime(new Date(when.getTime() + 30 * DAY))
    }
  }
  return out
}

/** 合：两颗行星黄经相同（角距 ≤ 4°），逐 12h 采样找过零点。 */
function conjunctionsBetween(from, to) {
  const out = []
  const stepMs = 12 * 3600000
  const fromMs = from.getTime()
  const toMs = to.getTime()
  for (let i = 0; i < CONJUNCTION_BODIES.length; i += 1) {
    for (let j = i + 1; j < CONJUNCTION_BODIES.length; j += 1) {
      const a = CONJUNCTION_BODIES[i]
      const b = CONJUNCTION_BODIES[j]
      let prevMs = fromMs
      let prev = relativeLongitude(a, b, prevMs)
      for (let ms = fromMs + stepMs; ms <= toMs; ms += stepMs) {
        const cur = relativeLongitude(a, b, ms)
        // |值| < 45° 才认为是「合」附近的过零，避免 ±180° 回绕误判
        if (Math.abs(prev) < 45 && Math.abs(cur) < 45 && Math.sign(prev) !== Math.sign(cur)) {
          const hitMs = refineCrossing(a, b, prevMs, ms)
          const sep = angularSeparation(a, b, hitMs)
          if (sep <= 4) {
            const when = new Date(hitMs)
            // 命名以亮星为先：木星合火星，而不是火星合木星
            const [first, second] = (BRIGHTNESS_ORDER[a] ?? 9) <= (BRIGHTNESS_ORDER[b] ?? 9) ? [a, b] : [b, a]
            out.push({
              id: `conj-${first.toLowerCase()}-${second.toLowerCase()}-${utcDay(when)}`,
              type: 'conjunction',
              body: first,
              objects: [first, second],
              utc: when.toISOString(),
              sepDeg: Math.round(sep * 100) / 100,
              label: `${PLANET_CN[first] ?? first}合${PLANET_CN[second] ?? second}`,
              note: `${PLANET_CN[first] ?? first}合${PLANET_CN[second] ?? second}，角距 ${(Math.round(sep * 100) / 100).toFixed(2)}°`,
            })
          }
        }
        prevMs = ms
        prev = cur
      }
    }
  }
  return out
}

/** 行星合月：月亮黄经追上行星（角距 ≤ 5° 才算「同框好看」）。 */
const MOON_CONJUNCTION_BODIES = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn']
const MOON_CONJUNCTION_SEP = 5

function moonConjunctionsBetween(from, to) {
  const out = []
  const stepMs = 6 * 3600000 // 月亮每天走 13°，6h 一步不会跳过过零点
  const fromMs = from.getTime()
  const toMs = to.getTime()
  for (const body of MOON_CONJUNCTION_BODIES) {
    let prevMs = fromMs
    let prev = relativeLongitude('Moon', body, prevMs)
    for (let ms = fromMs + stepMs; ms <= toMs; ms += stepMs) {
      const cur = relativeLongitude('Moon', body, ms)
      if (Math.abs(prev) < 45 && Math.abs(cur) < 45 && Math.sign(prev) !== Math.sign(cur)) {
        const hitMs = refineCrossing('Moon', body, prevMs, ms)
        const sep = angularSeparation('Moon', body, hitMs)
        if (sep <= MOON_CONJUNCTION_SEP) {
          const when = new Date(hitMs)
          out.push({
            id: `conj-moon-${body.toLowerCase()}-${utcDay(when)}`,
            type: 'conjunction',
            body,
            objects: [body, 'Moon'],
            utc: when.toISOString(),
            sepDeg: Math.round(sep * 100) / 100,
            label: `${PLANET_CN[body] ?? body}合月`,
            note: `${PLANET_CN[body] ?? body}合月，角距 ${(Math.round(sep * 100) / 100).toFixed(2)}°，月球会明显抬亮天空`,
          })
        }
      }
      prevMs = ms
      prev = cur
    }
  }
  return out
}

/** 大距：水星 / 金星离太阳角距最大。 */
function elongationsBetween(from, to) {
  const out = []
  for (const body of ['Mercury', 'Venus']) {
    let t = astro.makeTime(from)
    for (let i = 0; i < 12; i += 1) {
      let found
      try {
        found = A.SearchMaxElongation(A.Body[body], t)
      } catch (error) {
        break
      }
      const when = found.time.date
      if (when > to) break
      const evening = found.visibility === 'evening'
      out.push({
        id: `elong-${body.toLowerCase()}-${utcDay(when)}`,
        type: 'elongation',
        body,
        objects: [body],
        utc: when.toISOString(),
        sepDeg: Math.round(found.elongation * 10) / 10,
        label: `${PLANET_CN[body] ?? body}${evening ? '东' : '西'}大距`,
        note: `${PLANET_CN[body] ?? body}${evening ? '东大距（昏星）' : '西大距（晨星）'}，距日 ${found.elongation.toFixed(1)}°`,
      })
      t = astro.makeTime(new Date(when.getTime() + 20 * DAY))
    }
  }
  return out
}

/** [from, to] 内的行星事件：冲日 + 合（行星互合 / 行星合月）+ 大距，按时间排序。 */
export function planetEventsBetween(fromISO, toISO) {
  const from = new Date(fromISO)
  const to = new Date(toISO)
  const all = [
    ...oppositionsBetween(from, to),
    ...conjunctionsBetween(from, to),
    ...moonConjunctionsBetween(from, to),
    ...elongationsBetween(from, to),
  ]
  all.sort((a, b) => new Date(a.utc) - new Date(b.utc))
  return all
}

/**
 * 行星视星等（含相位角）。用于「越亮越高分」的评分。
 * @param {string} body astronomy-engine 的天体名，如 'Jupiter'
 * @returns {number|null}
 */
export function apparentMagnitude(body, when) {
  try {
    return A.Illumination(A.Body[body], astro.makeTime(new Date(when))).mag
  } catch (error) {
    return null
  }
}

/* ------------------------------------------------------------------ 提示 */

/** 下一次日月食（用于「所选日期没有月食，下一次是 …」）。 */
export function nextEclipseAfter(iso) {
  const t = astro.makeTime(new Date(iso))
  const candidates = []
  try {
    const lunar = A.SearchLunarEclipse(t)
    candidates.push({ ...shapeLunar(lunar), type: 'lunar' })
  } catch (error) { /* 忽略 */ }
  try {
    const solar = A.SearchGlobalSolarEclipse(t)
    candidates.push({ ...shapeSolar(solar), type: 'solar' })
  } catch (error) { /* 忽略 */ }
  candidates.sort((a, b) => new Date(a.peakUtc) - new Date(b.peakUtc))
  return candidates[0] ?? null
}
