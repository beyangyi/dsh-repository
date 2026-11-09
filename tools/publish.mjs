/**
 * 发布流程：`--check` 只体检，`--publish` 才真的发布。
 *
 *   node tools/publish.mjs --check      # 令牌、账号、仓库地址、打包内容、索引校验
 *   node tools/publish.mjs --publish    # npm publish → 刷新索引 → 校验 → 打印推送命令
 *
 * 令牌来源（按顺序）：本目录 .npmrc 里的 `_authToken=`，或环境变量 NPM_TOKEN。
 * 令牌永远不写进任何会被提交或打包的文件（.npmrc 已在 .gitignore 里，也不在 files 白名单内）。
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, openSync, closeSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { validateMarketIndex, formatIndexError } from './validate-market-index.mjs'
import { buildMarketIndex, isPlaceholder, repoUrls } from './build-market-index.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const REGISTRY = 'https://registry.npmjs.org/'
// npm 默认把日志/缓存写到用户目录，沙箱里不可写；统一落到工作区的 .npm-cache（已 gitignore）
const CACHE = join(ROOT, '.npm-cache')
// 直接跑 npm-cli.js：Windows 上 npm 是 .cmd，走 shell 在沙箱里会 EPERM
const NPM_CLI = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')

const args = process.argv.slice(2)
const mode = args.includes('--publish') ? 'publish' : 'check'
const problems = []
const notes = []

function readJson(file) {
  return JSON.parse(readFileSync(join(ROOT, file), 'utf8'))
}

function npm(args2, opts = {}) {
  // 沙箱里不能给子进程接管道（EPERM）：把 stdout/stderr 写进工作区文件再读回来
  mkdirSync(CACHE, { recursive: true })
  const logFile = join(CACHE, 'npm-out.log')
  const fd = openSync(logFile, 'w')
  // 所有 npm 调用都带 --cache：默认缓存目录在用户目录，沙箱里不可写
  const res = spawnSync(process.execPath, [NPM_CLI, ...args2, '--cache', CACHE], {
    cwd: ROOT,
    stdio: ['ignore', fd, fd],
    timeout: opts.timeout ?? 180000,
  })
  closeSync(fd)
  return { code: res.status ?? 1, out: readFileSync(logFile, 'utf8').trim(), error: res.error }
}

/** 从 .npmrc / 环境变量里取令牌（只判断「有没有」，不打印内容）。 */
function findToken() {
  const rc = join(ROOT, '.npmrc')
  if (existsSync(rc)) {
    const m = readFileSync(rc, 'utf8').match(/_authToken\s*=\s*(\S+)/)
    if (m && m[1] && !/^(?:\$\{|请|your)/i.test(m[1])) return { source: '.npmrc', value: m[1] }
  }
  if (process.env.NPM_TOKEN && !isPlaceholder(process.env.NPM_TOKEN)) return { source: 'NPM_TOKEN', value: process.env.NPM_TOKEN }
  return null
}

const pkg = readJson('package.json')
const config = readJson('market.config.json')

// 1) 包本身能不能发
if (pkg.private === true) problems.push('package.json 还是 private: true')
if (pkg.name.startsWith('@') && (!pkg.publishConfig || pkg.publishConfig.access !== 'public')) problems.push('scoped 包要在 package.json 写 publishConfig.access = "public"')
if (!pkg.name?.startsWith('@')) notes.push(`包名 ${pkg.name} 不是 scoped（可以，但市场条目会用这个名字）`)
if (!pkg.engines?.dsh) problems.push('package.json 缺少 engines.dsh（市场用它算兼容性）')

// 2) 令牌
const token = findToken()
if (!token) problems.push('没有 npm 令牌：把令牌写进 .npmrc（参考 .npmrc.example），或设置环境变量 NPM_TOKEN')

// 3) 仓库地址
const urls = repoUrls(config)
if (!urls) problems.push('market.config.json 的 owner / repository 还是空的（用于 homepage / repository 与索引地址）')

// 4) package.json 与 market.config.json 是否一致
const wantRepo = urls ? `git+${urls.repository}.git` : null
if (urls && pkg.repository && String(pkg.repository.url ?? pkg.repository) !== wantRepo) {
  notes.push(`package.json 的 repository 与 market.config.json 不一致，发布前会同步为 ${wantRepo}`)
}

// 5) 索引能不能过校验
let indexOk = false
try {
  const iconSvg = readFileSync(join(ROOT, config.icon ?? 'docs/icon.svg'), 'utf8')
  const previous = existsSync(join(ROOT, 'docs/market-index.json')) ? readJson('docs/market-index.json') : null
  const { doc } = buildMarketIndex({ pkg, config, iconSvg, previous, now: Date.now() })
  validateMarketIndex(doc, urls?.indexUrl ?? 'https://raw.githubusercontent.com/owner/repo/main/docs/market-index.json')
  indexOk = true
} catch (error) {
  problems.push(`索引校验失败：${formatIndexError(error)}`)
}

function syncPackageMeta() {
  if (!urls) return false
  const next = {
    ...pkg,
    repository: { type: 'git', url: `git+${urls.repository}.git` },
    homepage: urls.homepage,
    bugs: { url: urls.bugs },
  }
  const before = JSON.stringify(pkg, null, 2)
  const after = JSON.stringify(next, null, 2)
  if (before === after) return false
  writeFileSync(join(ROOT, 'package.json'), `${after}\n`)
  return true
}

function printSummary() {
  console.log(`包：${pkg.name}@${pkg.version}`)
  console.log(`索引：${urls ? urls.indexUrl : '（仓库地址未填，暂不可用）'}`)
  console.log(`令牌：${token ? `已找到（来自 ${token.source}）` : '缺失'}`)
  console.log(`索引校验：${indexOk ? '通过' : '未通过'}`)
  for (const n of notes) console.log(`· ${n}`)
  if (problems.length) {
    console.log('\n还差这些：')
    for (const p of problems) console.log(`  ✗ ${p}`)
  } else {
    console.log('\n✓ 体检通过，可以发布')
  }
}

if (mode === 'check') {
  // 账号信息（不打印令牌）
  if (token) {
    const who = npm(['whoami', '--registry', REGISTRY], { timeout: 60000 })
    if (who.code === 0) {
      const user = who.out.split('\n').pop().trim()
      console.log(`npm 账号：${user}`)
      const scope = pkg.name.startsWith('@') ? pkg.name.split('/')[0].slice(1) : ''
      if (scope && user !== scope) notes.push(`npm 账号是 ${user}，但包名 scope 是 @${scope}；scope 不属于该账号会发布失败（改包名或换账号）`)
    } else {
      problems.push(`npm whoami 失败：${who.out.split('\n').slice(-1)[0]}`)
    }
  }
  const pack = npm(['pack', '--dry-run', '--json'], { timeout: 120000 })
  if (pack.code === 0) {
    try {
      const info = JSON.parse(pack.out.slice(pack.out.indexOf('[')))[0]
      const kb = (info.size / 1024).toFixed(0)
      console.log(`打包：${info.entryCount} 个文件、${kb} KB（解包 ${(info.unpackedSize / 1024).toFixed(0)} KB）`)
      const bad = info.files.map((f) => f.path).filter((p) => /^(?:tests|tools|scripts)\/|\.npmrc$/.test(p))
      if (bad.length) problems.push(`包里混进了不该发的文件：${bad.slice(0, 5).join(', ')}`)
      if (info.size > 1.5 * 1024 * 1024) problems.push(`包体积 ${kb} KB 超过 1.5 MB`)
    } catch {
      notes.push('npm pack 输出无法解析，跳过体积检查')
    }
  } else {
    problems.push(`npm pack --dry-run 失败：${pack.out.split('\n').slice(-1)[0]}`)
  }
  printSummary()
  process.exit(problems.length ? 1 : 0)
}

// --publish
if (problems.length) {
  printSummary()
  console.error('\n✗ 体检没过，不发布。')
  process.exit(1)
}

if (syncPackageMeta()) console.log('· 已把 repository / homepage / bugs 同步进 package.json')

const who = npm(['whoami', '--registry', REGISTRY], { timeout: 60000 })
if (who.code !== 0) {
  console.error(`✗ npm whoami 失败：${who.out}`)
  process.exit(1)
}
console.log(`npm 账号：${who.out.split('\n').pop().trim()}`)

// 无 scope 的包不能带 --access public，scoped 包必须带
const accessArgs = pkg.name.startsWith('@') ? ['--access', 'public'] : []
const publish = npm(['publish', ...accessArgs, '--registry', REGISTRY], { timeout: 600000 })
console.log(publish.out)
if (publish.code !== 0) {
  console.error('✗ 发布失败（上面的输出里有原因）')
  process.exit(1)
}

function runTool(script, extra = []) {
  mkdirSync(CACHE, { recursive: true })
  const logFile = join(CACHE, 'tool-out.log')
  const fd = openSync(logFile, 'w')
  const res = spawnSync(process.execPath, [join(ROOT, 'tools', script), ...extra], { cwd: ROOT, stdio: ['ignore', fd, fd], timeout: 180000 })
  closeSync(fd)
  const out = readFileSync(logFile, 'utf8').trim()
  if (out) console.log(out)
  return res.status ?? 1
}

if (runTool('build-market-index.mjs', ['--publish-now']) !== 0) {
  console.error('✗ 索引生成失败')
  process.exit(1)
}
if (runTool('validate-market-index.mjs') !== 0) {
  console.error('✗ 索引校验失败')
  process.exit(1)
}

console.log('\n接下来把索引推到 GitHub：')
console.log('  git add docs/market-index.json package.json')
console.log(`  git commit -m "market: ${pkg.version}"`)
console.log('  git push')
console.log('\n然后在 DSH：插件 → 发现 → 添加索引 →', urls.indexUrl)
