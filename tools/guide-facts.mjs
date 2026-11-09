/**
 * 用户指南的「事实源」：所有会写进 `docs/user-guide.md` 的数字都从这里算出来，
 * 免得文档与代码/数据各说各话。`tests/guide.test.js` 用同一份数据反查文档。
 *
 * 用法：
 *   node tools/guide-facts.mjs            # 打印一份 JSON（写作时对照）
 *   import { guideFacts } from './guide-facts.mjs'
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { meta } from '../lib/planner.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))

/** 站点行是位置数组：[id, name, province, region, lat, lon, elev, bortle, tags, horizon, note] */
const SITE_FIELDS = ['id', 'name', 'province', 'region', 'lat', 'lon', 'elev', 'bortle', 'tags', 'horizon', 'note']

/** 深空细分（中文名与结果表一致）。 */
const DEEPSKY_LABEL = { galaxy: '星系', nebula: '星云', cluster: '星团', planetary: '行星状星云' }

/** 评分权重直接从 planner.js 源码里解析（改权重时文档测试会立刻发现）。 */
export function scoringWeights() {
  const source = readFileSync(join(ROOT, 'lib', 'planner.js'), 'utf8')
  const line = source.match(/const WEIGHTS = \{([^}]+)\}/u)
  if (!line) throw new Error('planner.js 里找不到 WEIGHTS')
  const weights = {}
  for (const part of line[1].split(',')) {
    const [key, value] = part.split(':').map((s) => s.trim())
    if (!key || !value) continue
    weights[key] = Number(value)
  }
  if (!Object.keys(weights).length) throw new Error('WEIGHTS 解析为空')
  return weights
}

export function guideFacts() {
  const metaData = meta()
  const sites = readJson('lib/data/sites-core.json').rows.map((row) =>
    Object.fromEntries(SITE_FIELDS.map((field, index) => [field, row[index]])))
  const targets = readJson('lib/data/targets.json').targets
  const cometData = readJson('lib/data/comets.json')
  const sky = readJson('lib/data/sky.json')
  const events = readJson('lib/data/events.json')

  const deepsky = targets.filter((t) => t.type === 'deepsky')
  const bySubtype = {}
  for (const [key, label] of Object.entries(DEEPSKY_LABEL)) {
    bySubtype[label] = deepsky.filter((t) => t.subtype === key).length
  }
  const byType = {}
  for (const target of targets) byType[target.type] = (byType[target.type] ?? 0) + 1

  const menu = metaData.eventTypes.length
  const groups = metaData.eventTypeGroups.map((group) => ({
    id: group.id,
    label: group.label,
    types: metaData.eventTypes.filter((t) => t.group === group.id).map((t) => t.label),
  }))
  const weights = scoringWeights()

  return {
    version: readJson('package.json').version,
    sites: {
      total: sites.length,
      provinces: new Set(sites.map((s) => s.province)).size,
      regions: [...new Set(sites.map((s) => s.region))],
      avgBortle: Number((sites.reduce((sum, s) => sum + s.bortle, 0) / sites.length).toFixed(2)),
    },
    targets: {
      total: targets.length,
      deepsky: deepsky.length,
      bySubtype,
      byType,
    },
    comets: { total: cometData.comets.length, updatedAt: cometData.updatedAt },
    sky: {
      stars: sky.stars.length,
      constellations: sky.constellations.length,
      milkywayLevels: sky.milkyway.length,
      magLimit: sky.magLimit,
      meteors: events.meteors.length,
      seasons: events.seasons.length,
    },
    types: { total: menu, groups, anyLabel: metaData.eventTypes.find((t) => t.id === 'any')?.label },
    scoring: { weights },
    ui: { tableColumns: 8, pageSize: 20, fovRange: [5, 180], maxRangeDays: 365 },
    weather: metaData.weather,
  }
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href
if (isMain) console.log(JSON.stringify(guideFacts(), null, 2))
