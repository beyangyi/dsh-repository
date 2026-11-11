import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

const SKIP_FILE = /^(?:\.npmrc|\.github-token|.*\.log|tmp-.*|.*\.tmp)$/u
const SKIP_DIR = /^(?:node_modules|\.npm-cache|\.git|tmp)$/u

function collect() {
  const files = []
  const walk = (abs, rel) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.isDirectory()) continue
      if (SKIP_DIR.test(entry.name)) continue
      const childAbs = join(abs, entry.name)
      const childRel = posix.join(rel, entry.name)
      if (entry.isDirectory()) walk(childAbs, childRel)
      else if (!SKIP_FILE.test(entry.name)) files.push(childRel)
    }
  }
  for (const dir of ['lib', 'docs', 'tests', 'tools', 'scripts']) {
    if (existsSync(join(ROOT, dir))) walk(join(ROOT, dir), dir)
  }
  for (const name of ['package.json', 'cordis.patch.yml', 'README.md', 'LICENSE', '.gitignore', 'screenshots.json']) {
    if (existsSync(join(ROOT, name))) files.push(name)
  }
  return files
}

test('安全：受版本管理的文件里没有任何凭据形态', () => {
  const rules = [
    new RegExp('gh' + 'p_[A-Za-z0-9]{20,}', 'u'),
    new RegExp('github' + '_pat_[A-Za-z0-9_]{20,}', 'u'),
    new RegExp('np' + 'm_[A-Za-z0-9]{30,}', 'u'),
    /-----BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY-----/u,
  ]
  const offenders = []
  for (const rel of collect()) {
    if (/\.(?:png|jpg|jpeg|webp|gif|docx|zip)$/iu.test(rel)) continue
    const text = read(rel)
    for (const rule of rules) {
      if (rule.test(text)) offenders.push(`${rel} 命中 ${rule.source.slice(0, 12)}…`)
    }
  }
  assert.deepEqual(offenders, [], `发现疑似凭据：\n${offenders.join('\n')}`)
})

test('安全：本地秘密文件都被 gitignore 覆盖，也不会被打进仓库', () => {
  const ignore = read('.gitignore').split(/\r?\n/u)
  for (const entry of ['.npmrc', '.github-token', '.npm-cache/']) {
    assert.ok(ignore.includes(entry), `.gitignore 缺少 ${entry}`)
  }
  const files = collect()
  assert.ok(!files.includes('.npmrc'), '.npmrc 不应进入推送列表')
  assert.ok(!files.includes('.github-token'), '.github-token 不应进入推送列表')
})

test('安全：三个推送脚本默认只读，必须显式 --allow-push 才写远端', () => {
  for (const script of ['tools/push-repo.mjs', 'tools/push-docs.mjs', 'tools/push-market-index.mjs']) {
    const source = read(script)
    assert.ok(source.includes("'--allow-push'"), `${script} 缺少 --allow-push 开关`)
    assert.ok(source.includes('只读模式'), `${script} 缺少只读模式提示`)
    assert.ok(source.includes('READ_ONLY_HINT') || source.includes('只读的'), `${script} 缺少 403 友好提示`)
  }
})

test('安全：维护文档写明权限边界与推送方式', () => {
  const doc = read('docs/maintaining.md')
  for (const keyword of ['谁能做什么', 'protect-main', 'non_fast_forward', '写令牌', '--allow-push', 'GitHub Desktop', 'SSH', 'Secret scanning', 'check-secrets']) {
    assert.ok(doc.includes(keyword), `docs/maintaining.md 缺少：${keyword}`)
  }
})

test('安全：仓库写权限审计脚本覆盖全部旁路', () => {
  const source = read('tools/verify-repo-lock.mjs')
  for (const item of ['collaborators', 'rulesets', 'deletion', 'non_fast_forward', 'keys', 'workflows']) {
    assert.ok(source.includes(item), `审计脚本缺少检查项：${item}`)
  }
  assert.ok(source.includes('只读'), '应声明只读审计')
  assert.ok(source.includes('--json'), '应支持 --json 输出')
})

test('安全：维护文档写清「谁能做什么」与公开仓库语义', () => {
  const doc = read('docs/maintaining.md')
  for (const keyword of ['谁能做什么', '其他人', '只能下载', '不能修改', 'fork', '助手（受你委托）', '助手代你推送', 'protect-main', 'non_fast_forward', 'Deploy keys', 'Secret scanning', 'GitHub Desktop', 'SSH', 'check-secrets', 'verify-repo-lock']) {
    assert.ok(doc.includes(keyword), `docs/maintaining.md 缺少：${keyword}`)
  }
})

test('安全：手动确认记录存在且审计脚本会读取它', () => {
  const lock = JSON.parse(read('docs/repo-lock.json'))
  assert.equal(lock.manualChecks.deployKeys.result, 'none', '部署密钥应已确认为空')
  assert.ok(lock.manualChecks.deployKeys.confirmedAt, '应记录确认日期')
  const source = read('tools/verify-repo-lock.mjs')
  assert.ok(source.includes("repo-lock.json"), '审计脚本应读取手动确认记录')
  assert.ok(source.includes("manualDone('deployKeys')"), '部署密钥应支持手动确认')
})

test('安全：秘密扫描在干净仓库上零命中', async () => {
  const { scanSecrets } = await import('../tools/check-secrets.mjs')
  const { scanned, problems } = scanSecrets()
  assert.ok(scanned > 50, `扫描文件数异常：${scanned}`)
  assert.deepEqual(problems, [], `扫描发现问题：\n${problems.join('\n')}`)
})
