#!/usr/bin/env node
/**
 * 站点库校验：坐标在国境与省内、字段完整、id 唯一、同省站点不撞点。
 * 用法：node scripts/validate-sites.mjs [--verbose]
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const verbose = process.argv.includes('--verbose')

const sites = JSON.parse(readFileSync(join(ROOT, 'lib/data/sites-core.json'), 'utf8'))
const provinces = JSON.parse(readFileSync(join(ROOT, 'lib/data/sites-province.json'), 'utf8')).provinces

const CHINA = { latMin: 18, latMax: 54, lonMin: 73, lonMax: 135 }
const errors = []
const warnings = []

const seen = new Set()
const byProvince = {}

for (const row of sites.rows) {
  const [id, name, province, region, lat, lon, altM, bortle, tags, fg] = row
  const where = `[${id}]`

  if (!id || seen.has(id)) errors.push(`${where} id 缺失或重复`)
  seen.add(id)
  if (!name) errors.push(`${where} 缺 name`)
  if (!provinces[province]) errors.push(`${where} 省份「${province}」不在省级表内`)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) errors.push(`${where} 坐标非法`)
  if (lat < CHINA.latMin || lat > CHINA.latMax || lon < CHINA.lonMin || lon > CHINA.lonMax) {
    errors.push(`${where} 坐标 (${lat}, ${lon}) 超出中国范围`)
  }
  if (bortle < 1 || bortle > 9) errors.push(`${where} Bortle 越界：${bortle}`)
  if (!(altM >= 0 && altM < 9000)) errors.push(`${where} 海拔异常：${altM}`)
  if (!/^[mdrtal]+$/.test(String(tags ?? ''))) errors.push(`${where} tags 非法：${tags}`)
  if (!fg) warnings.push(`${where} 没有地景`)

  const p = provinces[province]
  if (p) {
    const [, latMin, latMax, lonMin, lonMax] = p
    const pad = 0.6
    if (lat < latMin - pad || lat > latMax + pad || lon < lonMin - pad || lon > lonMax + pad) {
      errors.push(`${where} 坐标不在 ${province} 包围盒内（${lat}, ${lon}）`)
    }
  }
  byProvince[province] = (byProvince[province] || 0) + 1
}

// 同省站点间距
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}
const rows = sites.rows
for (let i = 0; i < rows.length; i += 1) {
  for (let j = i + 1; j < rows.length; j += 1) {
    const a = rows[i]; const b = rows[j]
    if (a[2] !== b[2]) continue
    const km = distanceKm(a[4], a[5], b[4], b[5])
    if (km < 3) errors.push(`[${a[0]}] 与 [${b[0]}] 相距仅 ${km.toFixed(1)}km，疑似重复`)
  }
}

const provinceCount = Object.keys(byProvince).length
const total = rows.length
const avgBortle = rows.reduce((s, r) => s + r[7], 0) / total

console.log(`站点 ${total} 个 · 覆盖 ${provinceCount} 个省级行政区 · 平均 Bortle ${avgBortle.toFixed(2)}`)
if (verbose) {
  for (const [p, n] of Object.entries(byProvince).sort()) console.log(`  ${p}: ${n}`)
}
for (const w of warnings) console.log('WARN', w)
for (const e of errors) console.log('ERROR', e)

if (total < 90) errors.push(`站点数 ${total} < 90`)
if (provinceCount < 30) errors.push(`覆盖省份 ${provinceCount} < 30`)

if (errors.length > 0) {
  console.error(`\n校验失败：${errors.length} 个问题`)
  process.exit(1)
}
console.log('\n校验通过 ✓')
