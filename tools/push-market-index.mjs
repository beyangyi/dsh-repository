/**
 * 把 `docs/market-index.json` 推到 GitHub（插件市场的索引必须放在一个 http(s) 地址上）。
 *
 *   node tools/push-market-index.mjs --check    # 只看：令牌有没有、仓库/分支对不对、远端文件有没有变
 *   node tools/push-market-index.mjs            # 推上去（走 GitHub Contents API，一个文件一次提交）
 *
 * 令牌来源（按顺序）：本目录 `.github-token` 文件，或环境变量 GITHUB_TOKEN。
 * 令牌需要 `contents: write`（classic token 勾 repo 即可；fine-grained 勾 Contents）。
 * `.github-token` 已在 .gitignore 里，不会提交、也不会进 npm 包。
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateMarketIndex, formatIndexError } from './validate-market-index.mjs'
import { repoUrls, isPlaceholder } from './build-market-index.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const args = process.argv.slice(2)
const checkOnly = args.includes('--check')

const readJson = (file) => JSON.parse(readFileSync(join(ROOT, file), 'utf8'))
const config = readJson('market.config.json')
const urls = repoUrls(config)
if (!urls) {
  console.error('✗ market.config.json 的 owner / repository 还没填')
  process.exit(2)
}
const [owner, repo] = [urls.owner, urls.name]
const INDEX_PATH = 'docs/market-index.json'
const API = `https://api.github.com/repos/${owner}/${repo}/contents/${INDEX_PATH}`

function findToken() {
  const file = join(ROOT, '.github-token')
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8').trim()
    if (text && !isPlaceholder(text)) return { source: '.github-token', value: text }
  }
  const env = process.env.GITHUB_TOKEN
  if (env && !isPlaceholder(env)) return { source: 'GITHUB_TOKEN', value: env }
  return null
}

const token = findToken()
const local = readFileSync(join(ROOT, INDEX_PATH), 'utf8')
try {
  validateMarketIndex(JSON.parse(local), urls.indexUrl)
} catch (error) {
  console.error(`✗ 本地索引不合法：${formatIndexError(error)}`)
  process.exit(1)
}

async function gh(method = 'GET', body) {
  const res = await fetch(API, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token.value}`,
      'user-agent': 'dsh-astro-plan',
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  return { status: res.status, json, text }
}

async function remoteState() {
  if (!token) return { status: 401, json: null }
  const res = await fetch(API, {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token.value}`, 'user-agent': 'dsh-astro-plan' },
  })
  if (res.status === 404) return { status: 404, json: null }
  const json = await res.json()
  return { status: res.status, json }
}

const remote = await remoteState()
console.log(`仓库：${owner}/${repo}`)
console.log(`索引：${INDEX_PATH}（${urls.indexUrl}）`)
console.log(`令牌：${token ? `已找到（来自 ${token.source}）` : '缺失'}`)
if (remote.status === 200) console.log(`远端：已有该文件，sha ${String(remote.json.sha).slice(0, 7)}`)
else if (remote.status === 404) console.log('远端：还没有 docs/market-index.json（首次推送会新建）')
else if (remote.status === 401) console.log('远端：没有令牌，无法读取')
else console.log(`远端：HTTP ${remote.status}`)

const sameAsRemote = remote.json && remote.json.content
  ? Buffer.from(remote.json.content, 'base64').toString('utf8') === local
  : false
console.log(`内容：${sameAsRemote ? '与远端一致，无需推送' : '与远端不同（或远端没有）'}`)

// 注意：这里不要用 process.exit() 提前退出 —— fetch 的句柄还在关闭中，
// Node 在 Windows 上会以 libuv 断言崩溃（退出码 0xC0000409）。让脚本自然结束即可。
if (!checkOnly) {
  if (!token) {
    console.error('✗ 没有 GitHub 令牌：把令牌写进 .github-token（参考 .github-token.example），或设置 GITHUB_TOKEN')
    process.exitCode = 1
  } else if (sameAsRemote) {
    console.log('✓ 无需推送')
  } else {
    const body = {
      message: `market: ${readJson('package.json').version}`,
      content: Buffer.from(local, 'utf8').toString('base64'),
      branch: 'main',
      ...(remote.json?.sha ? { sha: remote.json.sha } : {}),
    }
    const put = await gh('PUT', body)
    if (put.status === 200 || put.status === 201) {
      console.log(`✓ 已推送：${put.json.commit.html_url ?? put.json.commit.sha}`)
      console.log(`  市场索引地址：${urls.indexUrl}`)
      console.log('  在 DSH：插件 → 发现 → 添加索引 → 粘贴上面的地址')
    } else {
      console.error(`✗ 推送失败 HTTP ${put.status}：${(put.json?.message ?? put.text).slice(0, 300)}`)
      process.exitCode = 1
    }
  }
}
