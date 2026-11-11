/**
 * 把插件源码推到 GitHub 仓库（一次提交），用于 dsh-market 收录（收录要求仓库里有真实代码与 `dsh.bundle` manifest）。
 *
 *   node tools/push-repo.mjs --check     # 列出会推的文件与体积
 *   node tools/push-repo.mjs             # 推一次（内容没变就什么都不做）
 *
 * 令牌同 push-market-index.mjs：`.github-token` 或 GITHUB_TOKEN，需要 Contents: Read and write。
 * 秘密文件（.npmrc、.github-token、.npm-cache）永不进入推送列表。
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, posix, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const API = 'https://api.github.com'
const checkOnly = process.argv.includes('--check')
/** 只有显式带 --allow-push 才写远端；助手默认不带，避免误推。 */
const allowPush = process.argv.includes('--allow-push')
/** --exclude=<路径前缀> 可重复：本次不推送这些路径（如 --exclude=docs/wechat）。 */
const excludes = process.argv
  .filter((arg) => arg.startsWith('--exclude='))
  .map((arg) => arg.slice('--exclude='.length).replace(/\\/gu, '/').replace(/\/+$/u, ''))
  .filter(Boolean)
const excluded = (rel) => excludes.some((prefix) => rel === prefix || rel.startsWith(prefix + '/') || rel.startsWith(prefix))
const READ_ONLY_HINT = '令牌是只读的（或没有写入权限）：请改用你自己的凭据推送 —— GitHub 网页 Add file / GitHub Desktop / SSH。'

const SKIP_FILE = /^(?:\.npmrc|\.github-token|.*\.log|tmp-.*|.*\.tmp)$/u
const SKIP_DIR = /^(?:node_modules|\.npm-cache|\.git|tmp)$/u
const ROOT_FILES = ['package.json', 'cordis.patch.yml', 'README.md', 'LICENSE', '.gitignore', 'screenshots.json']
const DIRS = ['lib', 'docs', 'tests', 'tools', 'scripts']

function walk(abs, rel, out) {
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.isDirectory()) continue
    if (SKIP_DIR.test(entry.name)) continue
    const childAbs = join(abs, entry.name)
    const childRel = posix.join(rel, entry.name)
    if (entry.isDirectory()) { walk(childAbs, childRel, out); continue }
    if (SKIP_FILE.test(entry.name)) continue
    out.set(childRel, childAbs)
  }
}

const files = new Map()
for (const name of ROOT_FILES) {
  const abs = join(ROOT, name)
  if (existsSync(abs)) files.set(name, abs)
}
for (const dir of DIRS) {
  const abs = join(ROOT, dir)
  if (existsSync(abs)) walk(abs, dir, files)
}
for (const rel of [...files.keys()]) {
  if (excluded(rel)) files.delete(rel)
}

const config = JSON.parse(readFileSync(join(ROOT, 'market.config.json'), 'utf8'))
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const slug = config.repository.replace(/^.*github\.com\//u, '').replace(/\.git$/u, '')
const [owner, repo] = slug.split('/')
const branch = 'main'

function token() {
  const file = join(ROOT, '.github-token')
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8').trim()
    if (text) return text
  }
  return process.env.GITHUB_TOKEN ?? null
}

let total = 0
for (const [, abs] of files) total += statSync(abs).size
console.log(`仓库：${owner}/${repo}（${branch}）`)
if (excludes.length) console.log(`排除：${excludes.join(', ')}`)
console.log(`待推送：${files.size} 个文件，${(total / 1024).toFixed(0)} KB`)
for (const [rel, abs] of [...files].slice(0, 8)) console.log(`  ${rel}  ${(statSync(abs).size / 1024).toFixed(0)} KB`)
if (files.size > 8) console.log(`  … 另有 ${files.size - 8} 个`)
if (checkOnly) process.exit(0)
if (!allowPush) {
  console.log('\n（只读模式：加 --allow-push 才会真正写入远端；助手默认不带这个开关）')
  process.exit(0)
}

const auth = token()
if (!auth) {
  console.error('✗ 没有 GitHub 令牌（.github-token 或 GITHUB_TOKEN）')
  process.exit(2)
}

async function api(path, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${auth}`,
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

const ref = await api(`/repos/${owner}/${repo}/git/ref/heads/${branch}`)
const parentSha = ref.object.sha
const parent = await api(`/repos/${owner}/${repo}/git/commits/${parentSha}`)

const entries = []
const all = [...files]
for (let i = 0; i < all.length; i += 6) {
  const chunk = all.slice(i, i + 6)
  const blobs = await Promise.all(chunk.map(([, abs]) => api(`/repos/${owner}/${repo}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content: readFileSync(abs).toString('base64'), encoding: 'base64' }),
  })))
  chunk.forEach(([rel], index) => entries.push({ path: rel, mode: '100644', type: 'blob', sha: blobs[index].sha }))
  process.stdout.write(`\r  已上传 ${Math.min(i + 6, all.length)}/${all.length}`)
}
process.stdout.write('\n')

const tree = await api(`/repos/${owner}/${repo}/git/trees`, {
  method: 'POST',
  body: JSON.stringify({ base_tree: parent.tree.sha, tree: entries }),
})
if (tree.sha === parent.tree.sha) {
  console.log('✓ 仓库内容已经一致，无需提交')
  process.exit(0)
}
const commit = await api(`/repos/${owner}/${repo}/git/commits`, {
  method: 'POST',
  body: JSON.stringify({
    message: `feat: 源码入库（${pkg.name}@${pkg.version}）\n\n用户指南见 docs/user-guide.md；收录条目见 awesome-dsh-plugin。`,
    tree: tree.sha,
    parents: [parentSha],
  }),
})
await api(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
  method: 'PATCH',
  body: JSON.stringify({ sha: commit.sha }),
})
console.log(`✓ 已提交 ${commit.sha.slice(0, 7)}：${commit.html_url ?? ''}`)
