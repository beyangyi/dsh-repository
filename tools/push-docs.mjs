/**
 * 把文档（用户指南 + 配图）推到 GitHub：一次提交多个文件，走 Git Data API。
 *
 *   node tools/push-docs.mjs --check     # 只看：哪些文件会改、体积多少
 *   node tools/push-docs.mjs             # 提交一次
 *
 * 令牌来源同 push-market-index.mjs：`.github-token` 文件或 GITHUB_TOKEN 环境变量。
 * 需要 Contents: Read and write 权限。
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildMarketIndex } from './build-market-index.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const API = 'https://api.github.com'
const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
/** 只有显式带 --allow-push 才写远端；助手默认不带，避免误推。 */
const allowPush = args.includes('--allow-push')
const READ_ONLY_HINT = '令牌是只读的（或没有写入权限）：请改用你自己的凭据推送 —— GitHub 网页 Add file / GitHub Desktop / SSH。'

const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))
const config = readJson('market.config.json')
const pkg = readJson('package.json')

function findToken() {
  const file = join(ROOT, '.github-token')
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8').trim()
    if (text) return text
  }
  return process.env.GITHUB_TOKEN ?? null
}
const token = findToken()
if (!token) {
  console.error('✗ 没有 GitHub 令牌（.github-token 或 GITHUB_TOKEN）')
  process.exit(2)
}

const slug = config.repository.replace(/^.*github\.com\//u, '').replace(/\.git$/u, '')
const [owner, repo] = slug.split('/')
const branch = 'main'

/** 待推送的文件：仓库相对路径 → 本地绝对路径 */
const files = new Map()
const add = (rel, abs) => files.set(rel, abs)
add('docs/user-guide.md', join(ROOT, 'docs', 'user-guide.md'))
for (const name of readdirSync(join(ROOT, 'docs', 'images'))) {
  if (name.endsWith('.png')) add(posix.join('docs/images', name), join(ROOT, 'docs', 'images', name))
}
for (const rel of args.filter((a) => !a.startsWith('--'))) {
  if (existsSync(rel)) add(rel.replaceAll('\\', '/'), join(ROOT, rel))
}

async function api(path, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'dsh-astro-plan',
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  if (!res.ok) {
    const detail = `${init.method ?? 'GET'} ${path} → ${res.status} ${(json?.message ?? text).slice(0, 200)}`
    throw new Error(res.status === 403 ? `${detail}\n  ${READ_ONLY_HINT}` : detail)
  }
  return json
}

console.log(`仓库：${owner}/${repo}（分支 ${branch}）`)
console.log(`待推送：${files.size} 个文件`)
let total = 0
for (const [rel, abs] of files) {
  const size = readFileSync(abs).length
  total += size
  console.log(`  ${rel}  ${(size / 1024).toFixed(0)} KB`)
}
console.log(`合计 ${(total / 1024).toFixed(0)} KB`)
if (checkOnly) process.exit(0)
if (!allowPush) {
  console.log('\n（只读模式：加 --allow-push 才会真正写入远端；助手默认不带这个开关）')
  process.exit(0)
}

const ref = await api(`/repos/${owner}/${repo}/git/ref/heads/${branch}`)
const parentSha = ref.object.sha
const parent = await api(`/repos/${owner}/${repo}/git/commits/${parentSha}`)

const entries = []
for (const [rel, abs] of files) {
  const blob = await api(`/repos/${owner}/${repo}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content: readFileSync(abs).toString('base64'), encoding: 'base64' }),
  })
  entries.push({ path: rel, mode: '100644', type: 'blob', sha: blob.sha })
}

const tree = await api(`/repos/${owner}/${repo}/git/trees`, {
  method: 'POST',
  body: JSON.stringify({ base_tree: parent.tree.sha, tree: entries }),
})
const commit = await api(`/repos/${owner}/${repo}/git/commits`, {
  method: 'POST',
  body: JSON.stringify({
    message: `docs: 用户指南与配图（${pkg.version}）`,
    tree: tree.sha,
    parents: [parentSha],
  }),
})
await api(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
  method: 'PATCH',
  body: JSON.stringify({ sha: commit.sha }),
})
console.log(`✓ 已提交 ${commit.sha.slice(0, 7)}：${commit.html_url ?? ''}`)
console.log(`  指南：https://github.com/${owner}/${repo}/blob/${branch}/docs/user-guide.md`)
