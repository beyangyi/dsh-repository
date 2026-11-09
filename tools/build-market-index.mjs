/**
 * 生成插件市场索引 `docs/market-index.json`（format 1）。
 *
 * 数据来源：`package.json`（包名 / 版本 / 描述 / 引擎）+ `market.config.json`（仓库、作者、分类、标签、双语文案、图标）。
 * 历史版本会累积：每次发版跑一次，旧版本保留各自的 `publishTimestamp`。
 *
 * 用法：
 *   node tools/build-market-index.mjs                  # 写入 docs/market-index.json（当前版本若已存在则保留原时间戳）
 *   node tools/build-market-index.mjs --publish-now    # 用当前时间刷新当前版本的时间戳（发布后跑）
 *   node tools/build-market-index.mjs --dry-run        # 只打印，不写文件
 *   node tools/build-market-index.mjs --timestamp 1760000000
 *
 * 仓库地址还是占位符时仍会生成（省略 homepage/repository 字段），但会提示你填 `market.config.json`。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateMarketIndex, formatIndexError } from './validate-market-index.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const INDEX_FILE = join(ROOT, 'docs', 'market-index.json')
const PLACEHOLDER = /REPLACE-ME|your-|example\.com|<.*>/i

export function isPlaceholder(value) {
  return typeof value !== 'string' || value.trim() === '' || PLACEHOLDER.test(value)
}

/**
 * 由仓库配置推导 GitHub 相关 URL；占位符时返回 null。
 * `repository` 三种写法都认：完整 URL、`owner/name`、只写仓库名（owner 取自 `owner` 字段）。
 */
export function repoUrls(config) {
  if (!config || isPlaceholder(config.repository)) return null
  const raw = String(config.repository).trim().replace(/\.git$/, '').replace(/\/$/, '')
  let owner = config.owner && !isPlaceholder(config.owner) ? String(config.owner).trim() : ''
  let name = ''
  if (/^https?:\/\//i.test(raw)) {
    const m = raw.match(/github\.com\/([^/]+)\/([^/]+)/i)
    if (!m) return null
    owner = owner || m[1]
    name = m[2]
  } else if (raw.includes('/')) {
    const m = raw.match(/^([^/]+)\/([^/]+)$/)
    if (!m) return null
    owner = owner || m[1]
    name = m[2]
  } else {
    name = raw
  }
  if (!owner || !name) return null
  const repository = `https://github.com/${owner}/${name}`
  return {
    repository,
    homepage: `${repository}#readme`,
    bugs: `${repository}/issues`,
    indexUrl: `https://raw.githubusercontent.com/${owner}/${name}/main/docs/market-index.json`,
    owner,
    name,
  }
}

/** 包名 → 市场插件条目的名称（与 package.json 完全一致）。 */
function pluginEntry({ pkg, config, iconSvg, previous, now }) {
  const urls = repoUrls(config)
  const icon = svgDataUrl(iconSvg)
  const prevVersions = Array.isArray(previous?.plugins?.[0]?.versions) ? previous.plugins[0].versions : []
  const others = prevVersions.filter((v) => v.version !== pkg.version)
  const existing = prevVersions.find((v) => v.version === pkg.version)
  const stamp = Math.floor(now / 1000)
  const entry = {
    version: pkg.version,
    publishTimestamp: existing && !process.env.MARKET_REFRESH_TS ? existing.publishTimestamp : stamp,
    source: { type: 'npm' },
    engines: { dsh: pkg.engines.dsh },
  }
  return {
    name: pkg.name,
    title: config.title,
    description: config.description,
    icon,
    ...(config.author ? { author: config.author } : {}),
    ...(urls ? { homepage: urls.homepage, repository: { url: urls.repository } } : {}),
    metadata: {
      category: config.category,
      keywords: pkg.keywords ?? [],
      labels: config.labels ?? [],
    },
    versions: [entry, ...others],
  }
}

export function svgDataUrl(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}

export function buildMarketIndex({ pkg, config, iconSvg, previous, now = Date.now() }) {
  const doc = {
    format: 1,
    title: { en: 'DeepSeek Harness Plugin Market · by Sirius YANG', zh: '星野计划 · 插件索引' },
    description: {
      en: 'Curated DeepSeek Harness bundles published by Sirius YANG.',
      zh: '由 Sirius YANG 维护的 DeepSeek Harness 插件索引。',
    },
    metadata: {
      categories: { planning: { title: { en: 'Planning', zh: '规划' } } },
      labels: {
        astronomy: { title: { en: 'Astronomy', zh: '天文' } },
        planning: { title: { en: 'Planning', zh: '规划' } },
        'web-ui': { title: { en: 'Web UI', zh: 'Web 界面' } },
      },
    },
    plugins: [pluginEntry({ pkg, config, iconSvg, previous, now })],
  }
  const missing = []
  if (!repoUrls(config)) missing.push('market.config.json 的 owner / repository 还是空的')
  return { doc, missing }
}

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href
if (isMain) {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const publishNow = args.includes('--publish-now')
  const tsArg = args.indexOf('--timestamp')
  const stampMs = tsArg >= 0 ? Number(args[tsArg + 1]) * 1000 : Date.now()
  if (tsArg >= 0 && !Number.isFinite(stampMs)) {
    console.error('✗ --timestamp 需要一个 Unix 秒整数')
    process.exit(2)
  }
  if (publishNow) process.env.MARKET_REFRESH_TS = '1'

  const pkg = readJson(join(ROOT, 'package.json'), null)
  const config = readJson(join(ROOT, 'market.config.json'), null)
  if (!pkg || !config) {
    console.error('✗ 缺少 package.json 或 market.config.json')
    process.exit(2)
  }
  const iconSvg = readFileSync(join(ROOT, config.icon ?? 'docs/icon.svg'), 'utf8')
  const previous = readJson(INDEX_FILE, null)
  const { doc, missing } = buildMarketIndex({ pkg, config, iconSvg, previous, now: stampMs })

  // 生成前先自检：任何一条规则不满足都不要写坏文件
  const indexUrl = repoUrls(config)?.indexUrl ?? 'https://raw.githubusercontent.com/owner/repo/main/docs/market-index.json'
  try {
    validateMarketIndex(doc, indexUrl)
  } catch (error) {
    console.error(`✗ 生成的索引不合法：${formatIndexError(error)}`)
    process.exit(1)
  }

  const text = `${JSON.stringify(doc, null, 2)}\n`
  if (dryRun) {
    console.log(text)
  } else {
    mkdirSync(dirname(INDEX_FILE), { recursive: true })
    writeFileSync(INDEX_FILE, text)
    console.log(`✓ 写入 ${INDEX_FILE}`)
    console.log(`  插件 ${doc.plugins[0].name}，版本 ${doc.plugins[0].versions.map((v) => v.version).join(', ')}`)
  }
  if (missing.length) {
    console.warn('! 还差一项：' + missing.join('；'))
    console.warn('  填好 market.config.json 后重跑本脚本，索引才会带 homepage / repository。')
  }
  if (!dryRun && repoUrls(config)) console.log(`  市场索引地址：${repoUrls(config).indexUrl}`)
}
