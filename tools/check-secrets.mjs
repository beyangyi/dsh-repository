/**
 * 秘密扫描：确认仓库里没有任何会被当成「令牌」的字符串，且本地秘密文件都被 gitignore 覆盖。
 *
 *   node tools/check-secrets.mjs           # 0 命中 → 退出码 0
 *   node tools/check-secrets.mjs --verbose # 列出扫描过的文件数
 *
 * 扫描范围与 tools/push-repo.mjs 一致（受版本管理的文件），跳过 .npmrc / .github-token 这类本地秘密文件。
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href
const verbose = process.argv.includes('--verbose')

const SKIP_FILE = /^(?:\.npmrc|\.github-token|.*\.log|tmp-.*|.*\.tmp)$/u
const SKIP_DIR = /^(?:node_modules|\.npm-cache|\.git|tmp)$/u
const ROOT_FILES = ['package.json', 'cordis.patch.yml', 'README.md', 'LICENSE', '.gitignore', 'screenshots.json']
const DIRS = ['lib', 'docs', 'tests', 'tools', 'scripts']

/** 会被 GitHub / npm 当成凭据的形态。故意写成拼接，避免本文件自身命中。 */
const RULES = [
  { name: 'GitHub classic token', pattern: new RegExp('gh' + 'p_[A-Za-z0-9]{20,}', 'u') },
  { name: 'GitHub fine-grained token', pattern: new RegExp('github' + '_pat_[A-Za-z0-9_]{20,}', 'u') },
  { name: 'npm token', pattern: new RegExp('np' + 'm_[A-Za-z0-9]{30,}', 'u') },
  { name: '私钥', pattern: /-----BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY-----/u },
  { name: 'Slack token', pattern: new RegExp('xo' + 'xb-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{20,}', 'u') },
]

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

export function scanSecrets({ verbose: showStats = false } = {}) {
const findings = []
let scanned = 0
let bytes = 0
for (const [rel, abs] of files) {
  const stat = statSync(abs)
  if (stat.size > 4 * 1024 * 1024) continue // 大文件（图片等）不扫
  if (/\.(?:png|jpg|jpeg|webp|gif|docx|zip|tgz)$/iu.test(rel)) continue
  const text = readFileSync(abs, 'utf8')
  scanned += 1
  bytes += text.length
  for (const rule of RULES) {
    const match = rule.pattern.exec(text)
    if (match) findings.push({ rel, rule: rule.name, sample: `${match[0].slice(0, 8)}…（${match[0].length} 字符）` })
  }
}

const problems = []

// 1) 受管理文件里不能出现凭据形态
for (const finding of findings) problems.push(`${finding.rel}：疑似 ${finding.rule} → ${finding.sample}`)

// 2) 本地秘密文件必须在 gitignore 里，且不能出现在扫描集合中
const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8')
for (const entry of ['.npmrc', '.github-token', '.npm-cache/']) {
  if (!ignore.split(/\r?\n/u).includes(entry)) problems.push(`.gitignore 缺少 ${entry}`)
}
for (const secret of ['.npmrc', '.github-token']) {
  if (files.has(secret)) problems.push(`${secret} 不应被当作文档文件推送`)
}

if (showStats) console.log(`扫描 ${scanned} 个文本文件，共 ${(bytes / 1024).toFixed(0)} KB`)
return { scanned, bytes, problems }
}

if (isMain) {
  const { scanned, problems } = scanSecrets({ verbose })
  if (problems.length) {
    console.error('✗ 发现可疑内容：')
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  console.log(`✓ 未发现凭据（扫描 ${scanned} 个文本文件）；.npmrc / .github-token 已被 gitignore 覆盖`)
}
