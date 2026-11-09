/**
 * 生成 lib/data/sky.json：亮星 + 星座连线（画面模拟用）。
 *
 * 数据来源：d3-celestial 0.7.35（BSD-3-Clause，https://github.com/ofrohn/d3-celestial），
 * 经 jsDelivr 取公开星表文件；这里只保留 mag ≤ 3.1 的亮星与中低纬可见的星座连线，
 * 转成「RA/Dec（度）+ 中文名」的紧凑 JSON，运行时不再联网。
 *
 * 用法：
 *   node tools/build-sky.mjs           # 重新生成（需联网）
 *   AP_BUILD_SKY=off node ...          # 只导入不执行（测试用）
 */

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'lib', 'data', 'sky.json')

const VERSION = '0.7.35'
const BASE = `https://cdn.jsdelivr.net/npm/d3-celestial@${VERSION}/data`
const MAG_LIMIT = 4.2
const MIN_DEC = -55 // 中国可见的星座下限（南天深处的星座不收录）

/** [−180,180] → [0,360) 度。 */
const normRa = (lon) => ((Number(lon) % 360) + 360) % 360

async function getJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  return res.json()
}

/** 88 个 IAU 星座的中文名（d3-celestial 的 constellations.cn.json 是「三垣二十八宿」，不是 IAU 译名）。 */
const CONSTELLATION_CN = {
  And: '仙女座', Ant: '唧筒座', Aps: '天燕座', Aqr: '宝瓶座', Aql: '天鹰座', Ara: '天坛座',
  Ari: '白羊座', Aur: '御夫座', Boo: '牧夫座', Cae: '雕具座', Cam: '鹿豹座', Cnc: '巨蟹座',
  CVn: '猎犬座', CMa: '大犬座', CMi: '小犬座', Cap: '摩羯座', Car: '船底座', Cas: '仙后座',
  Cen: '半人马座', Cep: '仙王座', Cet: '鲸鱼座', Cha: '蝘蜓座', Cir: '圆规座', Col: '天鸽座',
  Com: '后发座', CrA: '南冕座', CrB: '北冕座', Crv: '乌鸦座', Crt: '巨爵座', Cru: '南十字座',
  Cyg: '天鹅座', Del: '海豚座', Dor: '剑鱼座', Dra: '天龙座', Equ: '小马座', Eri: '波江座',
  For: '天炉座', Gem: '双子座', Gru: '天鹤座', Her: '武仙座', Hor: '时钟座', Hya: '长蛇座',
  Hyi: '水蛇座', Ind: '印第安座', Lac: '蝎虎座', Leo: '狮子座', LMi: '小狮座', Lep: '天兔座',
  Lib: '天秤座', Lup: '豺狼座', Lyn: '天猫座', Lyr: '天琴座', Men: '山案座', Mic: '显微镜座',
  Mon: '麒麟座', Mus: '苍蝇座', Nor: '矩尺座', Oct: '南极座', Oph: '蛇夫座', Ori: '猎户座',
  Pav: '孔雀座', Peg: '飞马座', Per: '英仙座', Phe: '凤凰座', Pic: '绘架座', Psc: '双鱼座',
  PsA: '南鱼座', Pup: '船尾座', Pyx: '罗盘座', Ret: '网罟座', Sge: '天箭座', Sgr: '人马座',
  Sco: '天蝎座', Scl: '玉夫座', Sct: '盾牌座', Ser: '巨蛇座', Sex: '六分仪座', Tau: '金牛座',
  Tel: '望远镜座', Tri: '三角座', TrA: '南三角座', Tuc: '杜鹃座', UMa: '大熊座', UMi: '小熊座',
  Vel: '船帆座', Vir: '室女座', Vol: '飞鱼座', Vul: '狐狸座',
}

/** starnames.cn.json 可能是 {HIP: {...}} 或数组，统一成 Map<number, 名称>。 */
function nameMap(raw) {
  const map = new Map()
  const put = (key, entry) => {
    const hip = Number(entry?.hip ?? key)
    if (!Number.isFinite(hip)) return
    const name = entry?.name || entry?.desig || ''
    if (name) map.set(hip, String(name).trim())
  }
  if (Array.isArray(raw)) raw.forEach((entry, i) => put(entry?.hip ?? i, entry))
  else Object.entries(raw ?? {}).forEach(([key, entry]) => put(key, entry))
  return map
}

async function main() {
  const [starsRaw, linesRaw, namesRaw, mwRaw] = await Promise.all([
    getJson(`${BASE}/stars.6.json`),
    getJson(`${BASE}/constellations.lines.json`),
    getJson(`${BASE}/starnames.cn.json`),
    getJson(`${BASE}/mw.json`),
  ])

  const names = nameMap(namesRaw)

  // 亮星：GeoJSON Point，properties.mag，coordinates [lon, lat]
  const stars = (starsRaw.features ?? [])
    .map((f) => {
      const [lon, lat] = f.geometry?.coordinates ?? []
      const mag = Number(f.properties?.mag)
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(mag)) return null
      if (mag > MAG_LIMIT) return null
      const hip = Number(f.id)
      return {
        ra: Math.round(normRa(lon) * 1000) / 1000,
        dec: Math.round(lat * 1000) / 1000,
        mag: Math.round(mag * 100) / 100,
        name: names.get(hip) ?? '',
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.mag - b.mag)

  // 星座连线：MultiLineString，每条 path 是一段折线（中文名用内置 IAU 译名表）
  const constellations = []
  for (const f of linesRaw.features ?? []) {
    const paths = (f.geometry?.coordinates ?? [])
      .map((path) => path
        .map(([lon, lat]) => [Math.round(normRa(lon) * 100) / 100, Math.round(lat * 100) / 100])
        .filter(([ra, dec]) => Number.isFinite(ra) && Number.isFinite(dec)))
      .filter((path) => path.length >= 2)
    if (paths.length === 0) continue
    const visible = paths.some((path) => path.some(([, dec]) => dec > MIN_DEC))
    if (!visible) continue
    constellations.push({
      id: f.id,
      n: CONSTELLATION_CN[f.id] ?? f.id,
      paths,
    })
  }

  // 补一次去重：同一 HIP 的重复恒星只留最亮
  const seen = new Set()
  const uniqStars = []
  for (const s of stars) {
    const key = `${s.ra.toFixed(2)}|${s.dec.toFixed(2)}`
    if (seen.has(key)) continue
    seen.add(key)
    uniqStars.push([s.ra, s.dec, s.mag, s.name])
  }

  // 银河：mw.json 是 5 级亮度等值线（级别越高越亮、面积越小），共 3 万点、110 KB。
  // 保留真实轮廓（含暗尘带 = 内环洞），用 Douglas–Peucker 抽稀到 0.25°，渲染时按近平面裁剪后填充，
  // 逐级叠加出明暗 —— 这比解析光带更贴近实拍。
  const simplifyRing = (points, tol) => {
    if (points.length <= 3) return points.slice()
    const keep = new Uint8Array(points.length)
    keep[0] = 1
    keep[points.length - 1] = 1
    const stack = [[0, points.length - 1]]
    const tol2 = tol * tol
    while (stack.length) {
      const [a, b] = stack.pop()
      let maxD = -1
      let idx = -1
      const [ax, ay] = points[a]
      const [bx, by] = points[b]
      const dx = bx - ax
      const dy = by - ay
      const len2 = dx * dx + dy * dy
      for (let i = a + 1; i < b; i += 1) {
        const [px, py] = points[i]
        let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0
        t = Math.max(0, Math.min(1, t))
        const qx = ax + t * dx - px
        const qy = ay + t * dy - py
        const d = qx * qx + qy * qy
        if (d > maxD) { maxD = d; idx = i }
      }
      if (maxD > tol2 && idx > 0) {
        keep[idx] = 1
        stack.push([a, idx], [idx, b])
      }
    }
    const out = []
    for (let i = 0; i < points.length; i += 1) if (keep[i]) out.push(points[i])
    return out
  }

  const milkyway = []
  for (let level = 0; level < (mwRaw.features ?? []).length; level += 1) {
    const polys = []
    for (const poly of mwRaw.features[level].geometry?.coordinates ?? []) {
      const rings = []
      for (const ring of poly) {
        const simplified = simplifyRing(ring, 0.25)
          .map(([lon, lat]) => [Math.round(normRa(lon) * 100) / 100, Math.round(lat * 100) / 100])
        if (simplified.length >= 3) rings.push(simplified)
      }
      if (rings.length) polys.push(rings)
    }
    if (polys.length) milkyway.push({ level, polys })
  }

  const doc = {
    source: `d3-celestial ${VERSION} · stars.6 / constellations.lines / starnames.cn / mw（BSD-3-Clause）`,
    url: `https://cdn.jsdelivr.net/npm/d3-celestial@${VERSION}/data`,
    fetched: new Date().toISOString().slice(0, 10),
    magLimit: MAG_LIMIT,
    minDec: MIN_DEC,
    count: uniqStars.length,
    stars: uniqStars,
    constellations,
    milkyway,
  }
  writeFileSync(OUT, `${JSON.stringify(doc)}\n`)
  console.log(`亮星 ${uniqStars.length} 颗（mag ≤ ${MAG_LIMIT}，含中文名 ${uniqStars.filter((s) => s[3]).length} 颗）`)
  console.log(`星座 ${constellations.length} 个（dec > ${MIN_DEC}°）`)
  const ringCount = milkyway.reduce((n, l) => n + l.polys.reduce((m, p) => m + p.length, 0), 0)
  const ptCount = milkyway.reduce((n, l) => n + l.polys.reduce((m, p) => m + p.reduce((k, r) => k + r.length, 0), 0), 0)
  console.log(`银河 ${milkyway.length} 级、${ringCount} 环、${ptCount} 点（等值线 0.25° 抽稀）`)
  console.log(`写出 ${OUT}`)
}

// 允许被测试/调试脚本导入而不触发网络请求
if (process.env.AP_BUILD_SKY !== 'off') {
  main().catch((error) => { console.error(error); process.exit(1) })
}
