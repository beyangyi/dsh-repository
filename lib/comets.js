/**
 * dsh-astro-plan — 彗星星历层。
 *
 * 数据来源：MPC（Minor Planet Center）CometEls.txt 的轨道根数与 H/G 亮度参数，
 * 由 tools/build-comets.mjs 生成 lib/data/comets.json（保留脚本，随时可重建）。
 *
 * 为什么不用 JPL SBDB 的 M1/K1：对多颗著名彗星（46P、103P、C/2023 A3）拟合偏差 3–7 等，
 * 会把真正的亮彗星漏掉；MPC 的 H/G 与历史极大亮度吻合（见 tests/comets.test.js 标定）。
 *
 * 传播：二体开普勒（椭圆 e<1 / 抛物线 e≈1 / 双曲 e>1），不含行星摄动与非引力项，
 * 因此日期离轨道历元越远误差越大——规划用途足够，但不适合精密定位。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as astro from './astro.js'

const HERE = dirname(fileURLToPath(import.meta.url))

const D2R = Math.PI / 180
const K_GAUSS = 0.01720209895 // 高斯引力常数，AU^1.5 / day
const OBLIQ = 23.4392911111 * D2R
const LIGHT_DAY = 0.005775518 // 光行 1 天对应的 AU

let catalog = { comets: [] }
try {
  catalog = JSON.parse(readFileSync(join(HERE, 'data', 'comets.json'), 'utf8'))
} catch {
  catalog = { comets: [] }
}

export const COMET_CATALOG = catalog
export const COMETS = Array.isArray(catalog.comets) ? catalog.comets : []
export const COMET_BY_ID = new Map(COMETS.map((c) => [c.id, c]))
export const COMET_META = {
  source: catalog.source ?? '—',
  url: catalog.url ?? null,
  fetched: catalog.fetched ?? null,
  updatedAt: catalog.updatedAt ?? null,
  method: catalog.method ?? null,
  window: catalog.window ?? null,
  count: COMETS.length,
}

/**
 * 重新读 comets.json 并就地替换（周更后调用，不必重启应用）。
 * 用原地 mutate 而不是重新赋值，是因为 planner/catalog 缓存的是这些导出的容器。
 */
export function reloadComets() {
  let next
  try {
    next = JSON.parse(readFileSync(join(HERE, 'data', 'comets.json'), 'utf8'))
  } catch {
    return false
  }
  const list = Array.isArray(next.comets) ? next.comets : []
  COMETS.length = 0
  COMETS.push(...list)
  COMET_BY_ID.clear()
  for (const c of COMETS) COMET_BY_ID.set(c.id, c)
  Object.assign(COMET_META, {
    source: next.source ?? '—',
    url: next.url ?? null,
    fetched: next.fetched ?? null,
    updatedAt: next.updatedAt ?? null,
    method: next.method ?? null,
    window: next.window ?? null,
    count: COMETS.length,
  })
  Object.assign(catalog, { comets: list })
  stateCache.clear()
  return true
}


/** 轨道根数 → 日心黄道 J2000 直角坐标（AU）。返回 { x, y, z, r }。 */
export function helioEcliptic(el, jd) {
  const { e, q, i, om, w, tp } = el
  let nu // 真近点角（弧度）
  let r // 日心距（AU）

  if (Math.abs(e - 1) < 1e-6) {
    // 抛物线：Barker 方程 D + D³/3 = K·(t−T)/q^1.5
    const D0 = Math.cbrt(1.5 * K_GAUSS * (jd - tp) / Math.pow(q, 1.5))
    let D = D0
    for (let n = 0; n < 12; n += 1) {
      D -= (D + (D * D * D) / 3 - D0) / (1 + D * D)
    }
    nu = 2 * Math.atan(D)
    r = q * (1 + D * D)
  } else if (e < 1) {
    const a = q / (1 - e)
    const n = K_GAUSS / Math.pow(a, 1.5) // 弧度/日
    let M = n * (jd - tp)
    M = ((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
    let E = e < 0.8 ? M : Math.PI
    for (let k = 0; k < 40; k += 1) {
      const step = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E))
      E -= step
      if (Math.abs(step) < 1e-12) break
    }
    const xv = a * (Math.cos(E) - e)
    const yv = a * Math.sqrt(1 - e * e) * Math.sin(E)
    nu = Math.atan2(yv, xv)
    r = Math.hypot(xv, yv)
  } else {
    // 双曲线：e·sinh H − H = M
    const a = q / (1 - e) // 负值
    const n = K_GAUSS / Math.pow(Math.abs(a), 1.5)
    const M = n * (jd - tp)
    let H = Math.asinh(M / e)
    for (let k = 0; k < 60; k += 1) {
      const step = (e * Math.sinh(H) - H - M) / (e * Math.cosh(H) - 1)
      H -= step
      if (Math.abs(step) < 1e-12) break
    }
    nu = 2 * Math.atan(Math.sqrt((e + 1) / (e - 1)) * Math.tanh(H / 2))
    r = Math.abs(a) * (e * Math.cosh(H) - 1)
  }

  const u = nu + w * D2R
  const cosO = Math.cos(om * D2R)
  const sinO = Math.sin(om * D2R)
  const cosI = Math.cos(i * D2R)
  const sinI = Math.sin(i * D2R)
  return {
    x: r * (cosO * Math.cos(u) - sinO * Math.sin(u) * cosI),
    y: r * (sinO * Math.cos(u) + cosO * Math.sin(u) * cosI),
    z: r * Math.sin(u) * sinI,
    r,
  }
}

/** 黄道 J2000 → 赤道 J2000。 */
function eclToEq(v) {
  return {
    x: v.x,
    y: v.y * Math.cos(OBLIQ) - v.z * Math.sin(OBLIQ),
    z: v.y * Math.sin(OBLIQ) + v.z * Math.cos(OBLIQ),
    r: v.r,
  }
}

/** 同一颗彗星在同一时刻的几何只算一次（站点无关）。 */
const stateCache = new Map()
const STATE_BUCKET_MS = 10 * 60000

/** 地球日心位置只与时刻有关：周更扫描 20 年 × 800 颗彗星时省下大量星历计算。 */
const earthCache = new Map()

function earthAt(bucket, time) {
  let earth = earthCache.get(bucket)
  if (!earth) {
    earth = astro.A.HelioVector(astro.A.Body.Earth, time)
    if (earthCache.size > 8000) earthCache.clear()
    earthCache.set(bucket, earth)
  }
  return earth
}

/**
 * 某时刻的彗星几何。
 * @returns {{mag:number, delta:number, r:number, elongation:number, vec:{x,y,z,t}}}
 */
export function cometState(comet, date) {
  const ms = (date instanceof Date ? date : new Date(date)).getTime()
  const bucket = Math.round(ms / STATE_BUCKET_MS)
  const key = `${comet.id}|${bucket}`
  const hit = stateCache.get(key)
  if (hit) return hit

  const time = astro.makeTime(new Date(bucket * STATE_BUCKET_MS))
  const jd = time.tt + 2451545.0
  const earth = earthAt(bucket, time)
  let helio = eclToEq(helioEcliptic(comet, jd))
  let delta = Math.hypot(helio.x - earth.x, helio.y - earth.y, helio.z - earth.z)
  // 光行时改正：用观测时刻减去光行时重算一次
  helio = eclToEq(helioEcliptic(comet, jd - delta * LIGHT_DAY))
  const gx = helio.x - earth.x
  const gy = helio.y - earth.y
  const gz = helio.z - earth.z
  delta = Math.hypot(gx, gy, gz)
  const r = helio.r
  const mag = comet.H + 5 * Math.log10(Math.max(delta, 1e-4)) + 2.5 * comet.G * Math.log10(Math.max(r, 1e-4))
  const se = Math.hypot(earth.x, earth.y, earth.z)
  const cos = -(gx * earth.x + gy * earth.y + gz * earth.z) / (delta * se || 1)
  const elongation = Math.acos(Math.max(-1, Math.min(1, cos))) / D2R

  const out = { mag, delta, r, elongation, vec: { x: gx, y: gy, z: gz, t: time } }
  if (stateCache.size > 40000) stateCache.clear()
  stateCache.set(key, out)
  return out
}

/** 彗星 → 地平坐标（含视差/折射）。 */
export function cometAltAz(comet, time, site) {
  const st = cometState(comet, time.date ?? time)
  return astro.vectorAltAz(st.vec, time, site)
}

/** 用于调试与测试：直接给轨道根数求状态。 */
export function stateFromElements(el, date) {
  return cometState(el, date)
}

export function clearCometCache() {
  stateCache.clear()
  earthCache.clear()
}
