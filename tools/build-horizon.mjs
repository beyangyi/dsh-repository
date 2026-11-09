/**
 * 用真实高程瓦片生成每个站点的整圈天际线（近景 / 远景两层）。
 *
 * 数据源：AWS Open Data「Terrain Tiles」（Mapzen terrarium，zoom 8，约 600 m/px，
 * 原始 DEM 为 SRTM/GMTED 等公开高程，无访问频率限制）。
 * 对每个站点沿 36 个方位（10° 步长）沿大圆从 1.5 km 采到 140 km，
 * 换算成视线仰角（含地球曲率与大气折射）后取分段最大：
 *
 *   angle = atan( (h - h0 - d*d/(2*R_eff)) / d )      R_eff = R/(1-k)，k 约 0.13
 *
 *   近景 = 1.5-25 km 最大仰角（挡住地平线的山脊 / 林带 / 楼群）
 *   远景 = 25-140 km 最大仰角（能从近景上方露出来的远山）
 *
 * 瓦片是 600 m 像元，1.5 km 以内采到的只会是观测点自己那一格，所以从 1.5 km 起。
 * 观测点高度用站点表里的实测海拔（h0），DEM 只负责周围地形。
 *
 * 输出 lib/data/horizon.json：{ step, sites: { id: { n: [...], f: [...] } } }，单位度。
 * 瓦片缓存在系统临时目录，重跑不重复下载。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { inflateSync } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(HERE, '..', 'lib', 'data')
const OUT = join(DATA, 'horizon.json')
const PARTIAL = join(DATA, 'horizon.partial.json')
const CACHE = join(tmpdir(), 'dsh-astro-plan-terrain')

const Z = 8
const STEP = 10
const AZS = Array.from({ length: 360 / STEP }, (_, i) => i * STEP)
const NEAR_KM = 25
const MAX_KM = 140
const CAP_DEG = 45
const R_EARTH = 6371000
const R_EFF = R_EARTH / (1 - 0.13)
const D2R = Math.PI / 180
const R2D = 180 / Math.PI

function loadSites() {
  const core = JSON.parse(readFileSync(join(DATA, 'sites-core.json'), 'utf8')).rows
  let user = []
  try {
    user = JSON.parse(readFileSync(join(DATA, 'sites.user.json'), 'utf8')).rows
  } catch {
    user = []
  }
  const seen = new Set()
  return [...core, ...user]
    .map(([id, name, , , lat, lon, altM]) => ({ id, name, lat, lon, altM }))
    .filter((s) => {
      if (seen.has(s.id)) return false
      seen.add(s.id)
      return Number.isFinite(s.lat) && Number.isFinite(s.lon)
    })
}

/* ---------------- terrarium PNG 解码 ---------------- */

function decodePng(buf) {
  let pos = 8
  let width = 0
  let height = 0
  let colorType = 0
  let bitDepth = 0
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(`不支持的 PNG：depth ${bitDepth} type ${colorType}`)
      }
      if (data[12] !== 0) throw new Error('不支持隔行 PNG')
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const ch = colorType === 6 ? 4 : 3
  const stride = width * ch
  const out = Buffer.alloc(width * height * ch)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const cur = Buffer.from(line)
    for (let i = 0; i < stride; i += 1) {
      const a = i >= ch ? cur[i - ch] : 0
      const b = prev[i]
      const c = i >= ch ? prev[i - ch] : 0
      let v = cur[i]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : (pb <= pc ? b : c)
      }
      cur[i] = v & 255
    }
    cur.copy(out, y * stride)
    prev = cur
  }
  return { width, height, ch, data: out }
}

const tileCache = new Map()

function tileXY(lat, lon) {
  const n = 2 ** Z
  const x = ((lon + 180) / 360) * n
  const s = Math.sin(lat * D2R)
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n
  return { x, y }
}

async function fetchTile(tx, ty) {
  const key = `${Z}/${tx}/${ty}`
  if (tileCache.has(key)) return tileCache.get(key)
  const file = join(CACHE, String(Z), String(tx), `${ty}.png`)
  let buf = null
  if (existsSync(file)) {
    buf = readFileSync(file)
  } else {
    const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${tx}/${ty}.png`
    for (let attempt = 0; attempt < 4 && !buf; attempt += 1) {
      try {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        buf = Buffer.from(await res.arrayBuffer())
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, buf)
      } catch (err) {
        if (attempt === 3) throw err
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)))
      }
    }
  }
  const png = decodePng(buf)
  tileCache.set(key, png)
  return png
}

/** 某经纬度的高程（米）；取不到的瓦片返回 null。 */
function elevationAt(lat, lon) {
  const p = tileXY(lat, lon)
  const tx = Math.floor(p.x)
  const ty = Math.floor(p.y)
  const png = tileCache.get(`${Z}/${tx}/${ty}`)
  if (!png) return null
  const px = Math.min(png.width - 1, Math.max(0, Math.floor((p.x - tx) * png.width)))
  const py = Math.min(png.height - 1, Math.max(0, Math.floor((p.y - ty) * png.height)))
  const i = (py * png.width + px) * png.ch
  const r = png.data[i]
  const g = png.data[i + 1]
  const b = png.data[i + 2]
  return r * 256 + g + b / 256 - 32768
}

/** 沿大圆走 d 米、方位 az 的落点。 */
function destination(lat, lon, azDeg, dM) {
  const delta = dM / R_EARTH
  const theta = azDeg * D2R
  const phi1 = lat * D2R
  const lam1 = lon * D2R
  const sinPhi2 = Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta)
  const phi2 = Math.asin(Math.max(-1, Math.min(1, sinPhi2)))
  const lam2 = lam1 + Math.atan2(
    Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
    Math.cos(delta) - Math.sin(phi1) * sinPhi2,
  )
  return [phi2 * R2D, ((lam2 * R2D + 540) % 360) - 180]
}

/** 采样距离表（米）：瓦片是约 600 m 像元，1.5 km 以内没有分辨率意义，从 1.5 km 起。 */
const SAMPLES = (() => {
  const out = []
  for (let d = 1500; d <= 6000; d += 500) out.push(d)
  for (let d = 7000; d <= 30000; d += 1000) out.push(d)
  for (let d = 32000; d <= MAX_KM * 1000; d += 2000) out.push(d)
  return out
})()

async function profileOf(site) {
  // 预取 5x5 瓦片（约 ±300 km，够 140 km 半径）
  const n = 2 ** Z
  const p = tileXY(site.lat, site.lon)
  const cx = Math.floor(p.x)
  const cy = Math.floor(p.y)
  const tasks = []
  for (let dx = -2; dx <= 2; dx += 1) {
    for (let dy = -2; dy <= 2; dy += 1) {
      const tx = ((cx + dx) % n + n) % n
      const ty = Math.max(0, Math.min(n - 1, cy + dy))
      tasks.push(fetchTile(tx, ty))
    }
  }
  await Promise.all(tasks)

  // 观测点高度用站点表里的实测海拔（DEM 的 600 m 像元落在坡下会把整圈地平线抬得离谱）
  const dem0 = elevationAt(site.lat, site.lon)
  const h0 = Number.isFinite(site.altM) ? Math.max(site.altM, dem0 ?? 0) : (dem0 ?? 0)
  const nArr = []
  const fArr = []
  for (const az of AZS) {
    let near = -90
    let far = -90
    for (const dM of SAMPLES) {
      const [la, lo] = destination(site.lat, site.lon, az, dM)
      const h = elevationAt(la, lo)
      if (h == null) continue
      const ang = Math.atan2(h - h0 - (dM * dM) / (2 * R_EFF), dM) * R2D
      if (dM <= NEAR_KM * 1000) near = Math.max(near, ang)
      else far = Math.max(far, ang)
    }
    const cap = (v) => Math.round(Math.max(-6, Math.min(CAP_DEG, v === -90 ? 0 : v)) * 10) / 10
    nArr.push(cap(near))
    fArr.push(cap(far))
  }
  return { n: nArr, f: fArr }
}

async function main() {
  const sites = loadSites()
  let done = {}
  if (existsSync(PARTIAL)) {
    done = JSON.parse(readFileSync(PARTIAL, 'utf8'))
    console.log(`续跑：已有 ${Object.keys(done).length} 个站点`)
  }
  mkdirSync(CACHE, { recursive: true })
  const t0 = Date.now()
  for (let i = 0; i < sites.length; i += 1) {
    const site = sites[i]
    if (done[site.id]) continue
    const { n, f } = await profileOf(site)
    done[site.id] = { n, f, max: Math.max(...n, ...f) }
    if (i % 10 === 0 || i === sites.length - 1) {
      writeFileSync(PARTIAL, JSON.stringify(done), 'utf8')
      const pct = ((Object.keys(done).length / sites.length) * 100).toFixed(0)
      console.log(`${Object.keys(done).length}/${sites.length} ${pct}% ${site.id} 最高 ${done[site.id].max}° 用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`)
    }
  }
  const out = {
    schema: 'astro-plan/horizon@2',
    source: 'AWS Open Data terrain-tiles (terrarium z8, 约 600 m/px)',
    generated: new Date().toISOString().slice(0, 10),
    step: STEP,
    zoom: Z,
    nearKm: NEAR_KM,
    maxKm: MAX_KM,
    sites: done,
  }
  writeFileSync(OUT, JSON.stringify(out), 'utf8')
  if (existsSync(PARTIAL)) unlinkSync(PARTIAL)
  const heights = Object.values(done).map((s) => s.max).sort((a, b) => a - b)
  console.log(`写入 ${OUT}：${Object.keys(done).length} 站，最高 ${heights[heights.length - 1]}°，中位 ${heights[Math.floor(heights.length / 2)]}°`)
}

main().catch((err) => {
  console.error('失败：', err)
  process.exit(1)
})
