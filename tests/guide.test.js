import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { guideFacts } from '../tools/guide-facts.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const guide = readFileSync(join(ROOT, 'docs', 'user-guide.md'), 'utf8')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const market = JSON.parse(readFileSync(join(ROOT, 'market.config.json'), 'utf8'))
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
const facts = guideFacts()

const SECTIONS = [
  '三种入口', '安装与打开', '查询区', '结果列表', '展开详情（便签）', '拍摄参数怎么来的',
  '画面模拟', '天气', '评分模型', '数据与更新', '在对话里怎么问', 'HTTP API', '已知边界与常见问题', '术语表',
]

test('用户指南：14 个章节齐全且按顺序编号', () => {
  SECTIONS.forEach((title, index) => {
    const heading = `## ${index + 1}. ${title}`
    assert.ok(guide.includes(heading), `缺少章节：${heading}`)
  })
  assert.ok(guide.startsWith('# 星野计划 · 用户指南'), '一级标题应为「星野计划 · 用户指南」')
})

test('用户指南：正文引用的配图都存在、够大也够小、alt 不空', () => {
  const links = [...guide.matchAll(/!\[([^\]]*)\]\((images\/[^)]+\.png)\)/gu)]
  assert.ok(links.length >= 8, `配图至少 8 张，实际 ${links.length}`)
  for (const [, alt, rel] of links) {
    assert.ok(alt.trim().length > 0, `${rel} 的 alt 不能为空`)
    const file = join(ROOT, 'docs', rel)
    assert.ok(existsSync(file), `缺图：${rel}（先跑 node tools/make-guide-images.mjs）`)
    const size = statSync(file).size
    assert.ok(size > 5 * 1024, `${rel} 只有 ${size} 字节，像是渲染失败`)
    assert.ok(size < 900 * 1024, `${rel} 有 ${Math.round(size / 1024)} KB，太大了`)
  }
})

test('用户指南：所有生成的配图都被正文引用（不留孤儿图）', () => {
  const used = new Set([...guide.matchAll(/\((images\/[^)]+\.png)\)/gu)].map((m) => m[1]))
  for (const name of ['01-overview', '02-results', '03-note', '04-sim-meteor', '05-sim-equatorial', '06-sim-moon', '07-type-menu', '08-pager', '08b-pager-detail']) {
    assert.ok(used.has(`images/${name}.png`), `配图 ${name}.png 没被引用`)
  }
})

test('用户指南：站点、目标、彗星、星表数字与数据一致', () => {
  assert.ok(guide.includes(`${facts.sites.total} 个`), `站点数应为 ${facts.sites.total}`)
  assert.ok(guide.includes(`${facts.sites.provinces} 个省级行政区`), `省级数应为 ${facts.sites.provinces}`)
  assert.ok(guide.includes(`${facts.targets.total} 个`), `目标数应为 ${facts.targets.total}`)
  assert.ok(guide.includes(`${facts.targets.deepsky}（星系`), `深空数应为 ${facts.targets.deepsky}`)
  for (const [label, count] of Object.entries(facts.targets.bySubtype)) {
    assert.ok(guide.includes(`${label} ${count}`), `深空细分 ${label} 应为 ${count}`)
  }
  assert.ok(guide.includes(`${facts.comets.total} 颗`), `彗星数应为 ${facts.comets.total}`)
  assert.ok(guide.includes(`${facts.sky.stars} 颗亮星`), `亮星数应为 ${facts.sky.stars}`)
  assert.ok(guide.includes(`${facts.sky.constellations} 个星座`), `星座数应为 ${facts.sky.constellations}`)
  assert.ok(guide.includes(`${facts.sky.milkywayLevels} 级银河`), `银河等值线应为 ${facts.sky.milkywayLevels} 级`)
})

test('用户指南：类型、列数、分页、视场、权重与代码一致', () => {
  assert.ok(guide.includes(`${facts.types.total} 个类型`), `类型数应为 ${facts.types.total}`)
  for (const group of facts.types.groups) {
    assert.ok(guide.includes(group.label), `缺少分组 ${group.label}`)
    for (const type of group.types) assert.ok(guide.includes(type), `缺少类型 ${type}`)
  }
  assert.ok(guide.includes('八列'), '结果表应是八列')
  assert.ok(guide.includes(`${facts.ui.pageSize} 条/页`), `分页应为每页 ${facts.ui.pageSize} 条`)
  assert.ok(guide.includes(`${facts.ui.fovRange[0]}°–${facts.ui.fovRange[1]}°`), '视场范围应与渲染器一致')
  const { weights } = facts.scoring
  assert.ok(guide.includes(`**${weights.sky}**`), `天象权重应为 ${weights.sky}`)
  assert.ok(guide.includes(`**${weights.weather}**`), `天气权重应为 ${weights.weather}`)
  assert.ok(guide.includes(`**${weights.foreground}**`), `地景权重应为 ${weights.foreground}`)
  assert.ok(guide.includes(`**${weights.pollution}**`), `光污染权重应为 ${weights.pollution}`)
  assert.ok(guide.includes(`**${weights.moon}**`), `月相权重应为 ${weights.moon}`)
})

test('用户指南：三个 HTTP 端点与五个工具动作都写到了', () => {
  for (const endpoint of ['/astro-plan/api/meta', '/astro-plan/api/search', '/astro-plan/api/night']) {
    assert.ok(guide.includes(endpoint), `缺少端点 ${endpoint}`)
  }
  for (const action of ['search', 'window', 'meta', 'events', 'params']) {
    assert.ok(guide.includes(`\`${action}\``), `缺少工具动作 ${action}`)
  }
})

test('介绍文本：中英都在 200 字符以内，且 package.json 与市场配置一致', () => {
  assert.ok(pkg.description.length <= 200, `package.json description ${pkg.description.length} 字符`)
  assert.ok(market.description.zh.length <= 200, `市场中文描述 ${market.description.zh.length} 字`)
  assert.ok(market.description.en.length <= 200, `市场英文描述 ${market.description.en.length} 字符`)
  assert.equal(pkg.description, market.description.zh, 'package.json 与 market.config.json 的中文描述应一字不差')
  assert.ok(readme.includes(pkg.description), 'README 首段应引用同一句介绍')
  assert.ok(readme.includes('docs/user-guide.md'), 'README 要链接到用户指南')
})
