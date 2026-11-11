/**
 * 只读审计：确认「只有仓库所有者能改」，并给出每一条的修复路径。
 *
 *   node tools/verify-repo-lock.mjs          # 人类可读报告；有问题时退出码 1
 *   node tools/verify-repo-lock.mjs --json   # 机器可读
 *
 * 只发 GET 请求（部署密钥需要管理权限，拿不到就标注「需手动确认」），不会改任何东西。
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const jsonMode = process.argv.includes('--json')

const config = JSON.parse(readFileSync(join(ROOT, 'market.config.json'), 'utf8'))
/** 需要管理权限、API 读不到的项，登记在 docs/repo-lock.json 里。 */
const lockFile = join(ROOT, 'docs', 'repo-lock.json')
const manual = existsSync(lockFile) ? (JSON.parse(readFileSync(lockFile, 'utf8')).manualChecks ?? {}) : {}
const manualDone = (key) => Boolean(manual[key] && manual[key].confirmedAt && manual[key].result !== 'unknown')
const owner = config.owner
const repo = config.repository.replace(/^.*github\.com\//u, '').replace(/\.git$/u, '').split('/')[1]

function token() {
  const file = join(ROOT, '.github-token')
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8').trim()
    if (text) return text
  }
  return process.env.GITHUB_TOKEN ?? null
}

const auth = token()
if (!auth) {
  console.error('✗ 没有只读令牌（.github-token 或 GITHUB_TOKEN）——审计需要读权限')
  process.exit(2)
}

async function call(path) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
    headers: { authorization: `Bearer ${auth}`, accept: 'application/vnd.github+json', 'user-agent': 'dsh-astro-plan' },
    signal: AbortSignal.timeout(25000),
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  return { status: res.status, json }
}

const checks = []
const record = (name, state, detail, fix) => checks.push({ name, state, detail, fix })

const repoInfo = await call('')
if (repoInfo.status !== 200) {
  console.error(`✗ 读不到仓库 ${owner}/${repo}（HTTP ${repoInfo.status}）——令牌失效或没有该仓库的读权限`)
  process.exit(2)
}
const defaultBranch = repoInfo.json.default_branch
record('仓库可见性', repoInfo.json.private ? 'warn' : 'ok',
  repoInfo.json.private ? '私有仓库：别人无法下载，但也会从 awesome-dsh-plugin 列表掉线' : '公开仓库：任何人可下载 / fork，但不能写入',
  '如需禁止下载只能转私有仓库（代价见 docs/maintaining.md）')

const collaborators = await call('/collaborators')
if (collaborators.status === 200 && Array.isArray(collaborators.json)) {
  const others = collaborators.json.map((c) => c.login).filter((login) => login.toLowerCase() !== owner.toLowerCase())
  record('协作者', others.length === 0 ? 'ok' : 'fail',
    others.length === 0 ? `只有 ${owner}` : `存在其他协作者：${others.join(', ')}`,
    'Settings → Collaborators → 移除多余成员')
} else {
  record('协作者', 'warn', `读不到（HTTP ${collaborators.status}）`, 'Settings → Collaborators 手动确认只有你')
}

const rulesets = await call('/rulesets')
let protectedBranch = null
if (rulesets.status === 200 && Array.isArray(rulesets.json)) {
  for (const summary of rulesets.json) {
    if (summary.enforcement !== 'active') continue
    const detail = await call(`/rulesets/${summary.id}`)
    if (detail.status !== 200) continue
    const types = (detail.json.rules ?? []).map((rule) => rule.type)
    // include 为空 = 作用于所有分支（GitHub 的默认“All branches”），也算保护到默认分支
    const includes = detail.json.conditions?.ref_name?.include ?? []
    const includesDefault = includes.length === 0
      || includes.includes('~ALL')
      || includes.some((ref) => ref === '~DEFAULT_BRANCH' || ref === defaultBranch || ref === `refs/heads/${defaultBranch}`)
    if (includesDefault && types.includes('deletion') && types.includes('non_fast_forward')) protectedBranch = summary.name
  }
  record('分支保护（删除 + 强推）', protectedBranch ? 'ok' : 'fail',
    protectedBranch ? `ruleset「${protectedBranch}」已启用 deletion + non_fast_forward` : '没有任何 ruleset 阻止删除 / 强制推送',
    'Settings → Rules → Rulesets → New branch ruleset：Target 填 main，勾 Restrict deletions 与 Block force pushes')
} else {
  record('分支保护（删除 + 强推）', 'warn', `读不到 rulesets（HTTP ${rulesets.status}）`, 'Settings → Rules 手动确认')
}

const workflows = await call('/contents/.github/workflows')
record('GitHub Actions workflow', workflows.status === 404 ? 'ok' : 'warn',
  workflows.status === 404 ? '仓库里没有 workflow，Actions 无从推送' : `存在 workflow（HTTP ${workflows.status}）`,
  'Settings → Actions → General：Workflow permissions 选 Read repository contents')

const keys = await call('/keys')
if (keys.status === 200 && Array.isArray(keys.json)) {
  const writable = keys.json.filter((key) => !key.read_only)
  record('部署密钥', keys.json.length === 0 ? 'ok' : writable.length ? 'fail' : 'warn',
    keys.json.length === 0 ? '没有任何部署密钥' : `共 ${keys.json.length} 个，可写 ${writable.length} 个`,
    'Settings → Deploy keys：删除，或改为只读')
} else if (manualDone('deployKeys')) {
  record('部署密钥', manual.deployKeys.result === 'none' ? 'ok' : 'fail',
    `手动确认（${manual.deployKeys.confirmedAt}）：${manual.deployKeys.detail ?? manual.deployKeys.result}`,
    'Settings → Deploy keys 删除可写密钥')
} else {
  record('部署密钥', 'warn', `令牌无管理权限，读不到（HTTP ${keys.status}）`, 'Settings → Deploy keys 手动确认后写进 docs/repo-lock.json')
}

if (manualDone('actionsPermissions')) record('Actions 权限（手动）', 'ok', manual.actionsPermissions.detail ?? '已确认', '—')
if (manualDone('secretScanningAndPushProtection')) record('Secret scanning（手动）', 'ok', manual.secretScanningAndPushProtection.detail ?? '已确认', '—')
if (manualDone('applications')) record('第三方应用（手动）', 'ok', manual.applications.detail ?? '已确认', '—')

const prs = await call(`/pulls?state=open&per_page=5`)
record('开放 PR', 'info', Array.isArray(prs.json) ? `${prs.json.length} 个` : '读不到', '—')

const fails = checks.filter((check) => check.state === 'fail')
const warns = checks.filter((check) => check.state === 'warn')

if (jsonMode) {
  console.log(JSON.stringify({ owner, repo, defaultBranch, checks, ok: fails.length === 0 }, null, 2))
} else {
  const icon = { ok: '✓', fail: '✗', warn: '⚠', info: '·' }
  console.log(`仓库：${owner}/${repo}（默认分支 ${defaultBranch}）\n`)
  for (const check of checks) {
    console.log(`${icon[check.state]} ${check.name}：${check.detail}`)
    if (check.state !== 'ok' && check.fix !== '—') console.log(`    → ${check.fix}`)
  }
  console.log('')
  if (fails.length) console.log(`✗ 还有 ${fails.length} 项没锁上（见上面 → 的路径）；修完重跑本命令。`)
  else if (warns.length) console.log(`✓ 没有可改的旁路；${warns.length} 项因权限读不到，请在 Settings 手动确认。`)
  else console.log('✓ 只有所有者可写：协作者只有你、main 禁止删除与强推、没有 workflow、没有部署密钥。')
}

process.exit(fails.length ? 1 : 0)
