/**
 * 生成离线省界图 `lib/data/china.json`（构建期联网一次，运行期零依赖）。
 *
 * 用法：
 *   node tools/build-china.mjs          # 拉数据并写文件
 *   node tools/build-china.mjs --check  # 只校验现有文件（不联网）
 *
 * 数据源：阿里 DataV 全国省级 GeoJSON（实测 200 / 291ms / 569KB / 35 feature）。
 * 抽稀后只保留 name 与多边形环，供「地图选点」在瓦片不可用时兜底。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const OUT = join(ROOT, 'lib', 'data', 'china.json')
const SOURCE = 'https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json'
const TOLERANCE = 0.02

/** Douglas–Peucker（与 build-sky.mjs 同一套思路）。 */
function simplify(points, tol) {
  if (points.length <= 3) return points.slice()
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack = [[0, points.length - 1]]
  while (stack.length) {
    const [first, last] = stack.pop()
    let maxDist = -1
    let index = -1
    const [x1, y1] = points[first]
    const [x2, y2] = points[last]
    const dx = x2 - x1
    const dy = y2 - y1
    const norm = Math.hypot(dx, dy) || 1e-9
    for (let i = first + 1; i < last; i += 1) {
      const [x, y] = points[i]
      const dist = Math.abs(dy * x - dx * y + x2 * y1 - y2 * x1) / norm
      if (dist > maxDist) { maxDist = dist; index = i }
    }
    if (maxDist > tol && index > 0) {
      keep[index] = 1
      stack.push([first, index], [index, last])
    }
  }
  const out = []
  for (let i = 0; i < points.length; i += 1) if (keep[i]) out.push(points[i])
  return out
}

function ringsOf(geometry) {
  if (!geometry) return []
  if (geometry.type === 'Polygon') return geometry.coordinates
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat()
  return []
}

async function build() {
  const res = await fetch(SOURCE, { headers: { 'user-agent': 'dsh-astro-plan/0.2.0 (+https://github.com/SiriusYANG91/dsh-astro-plan)' }, signal: AbortSignal.timeout(60000) })
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`)
  const geo = await res.json()
  if (!Array.isArray(geo?.features)) throw new Error('GeoJSON 结构异常：没有 features')
  console.log(`下载 ${geo.features.length} 个 feature，${(JSON.stringify(geo).length / 1024).toFixed(0)} KB`)

  const provinces = []
  let minLon = 180
  let minLat = 90
  let maxLon = -180
  let maxLat = -90
  for (const feature of geo.features) {
    const name = feature.properties?.name
    if (!name) continue
    const rings = []
    for (const ring of ringsOf(feature.geometry)) {
      if (!Array.isArray(ring) || ring.length < 4) continue
      const closed = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      const open = closed ? ring.slice(0, -1) : ring.slice()
      const simplified = simplify(open, TOLERANCE)
        .map(([lon, lat]) => [Math.round(lon * 100) / 100, Math.round(lat * 100) / 100])
      if (closed && simplified.length >= 3) simplified.push(simplified[0])
      if (simplified.length < 3) continue
      rings.push(simplified)
      for (const [lon, lat] of simplified) {
        if (lon < minLon) minLon = lon
        if (lon > maxLon) maxLon = lon
        if (lat < minLat) minLat = lat
        if (lat > maxLat) maxLat = lat
      }
    }
    if (rings.length) provinces.push({ name, rings })
  }
  if (provinces.length < 30) throw new Error(`省级单元过少：${provinces.length}`)

  const doc = {
    source: SOURCE,
    fetched: new Date().toISOString().slice(0, 10),
    tolerance: TOLERANCE,
    bbox: [minLon, minLat, maxLon, maxLat],
    provinces,
  }
  mkdirSync(dirname(OUT), { recursive: true })
  const text = `${JSON.stringify(doc)}\n`
  writeFileSync(OUT, text)
  console.log(`✓ 写出 ${OUT}：${provinces.length} 个省级单元，${(text.length / 1024).toFixed(0)} KB，bbox ${doc.bbox.join(', ')}`)
}

function check() {
  if (!existsSync(OUT)) throw new Error(`缺少 ${OUT}，先跑 node tools/build-china.mjs`)
  const doc = JSON.parse(readFileSync(OUT, 'utf8'))
  const size = readFileSync(OUT).length
  if (!Array.isArray(doc.bbox) || doc.bbox.length !== 4) throw new Error('bbox 不是四元组')
  if (!Array.isArray(doc.provinces) || doc.provinces.length < 30) throw new Error('省级单元过少')
  const [minLon, minLat, maxLon, maxLat] = doc.bbox
  for (const province of doc.provinces) {
    for (const ring of province.rings) {
      for (const [lon, lat] of ring) {
        if (lon < minLon - 0.01 || lon > maxLon + 0.01) throw new Error(`${province.name} 经度越界：${lon}`)
        if (lat < minLat - 0.01 || lat > maxLat + 0.01) throw new Error(`${province.name} 纬度越界：${lat}`)
      }
    }
  }
  if (size > 200 * 1024) throw new Error(`文件 ${(size / 1024).toFixed(0)} KB 超过 200 KB 上限`)
  console.log(`✓ ${OUT} 合法：${doc.provinces.length} 省，${(size / 1024).toFixed(0)} KB，bbox ${doc.bbox.join(', ')}`)
}

if (process.argv.includes('--check')) {
  try { check() } catch (error) { console.error(`✗ ${error.message}`); process.exit(1) }
} else {
  try {
    await build()
    check()
  } catch (error) {
    console.error(`✗ ${error.message}`)
    process.exit(1)
  }
}
