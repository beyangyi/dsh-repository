import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateMarketIndex, formatIndexError, MAX_INLINE_ICON_BYTES, compareSemver } from '../tools/validate-market-index.mjs'
import { buildMarketIndex, isPlaceholder, repoUrls, svgDataUrl } from '../tools/build-market-index.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (file) => JSON.parse(readFileSync(join(ROOT, file), 'utf8'))
const pkg = readJson('package.json')
const config = readJson('market.config.json')
const iconSvg = readFileSync(join(ROOT, config.icon), 'utf8')
const index = readJson('docs/market-index.json')
const INDEX_URL = repoUrls(config).indexUrl

test('市场索引：docs/market-index.json 通过 format 1 校验', () => {
  let doc
  try {
    doc = validateMarketIndex(index, INDEX_URL)
  } catch (error) {
    assert.fail(`索引不合法：${formatIndexError(error)}`)
  }
  assert.equal(doc.format, 1)
  assert.ok(doc.plugins.length >= 1, '至少一个插件')
  assert.ok(Object.hasOwn(doc.title, 'en'), 'title 必须含 en')
  assert.ok(doc.metadata.categories.planning, '分类 planning 要声明')
})

test('市场索引：包名与版本和 package.json 一致，版本降序不重复', () => {
  const entry = index.plugins.find((p) => p.name === pkg.name)
  assert.ok(entry, `索引里应有 ${pkg.name}`)
  const versions = entry.versions.map((v) => v.version)
  assert.ok(versions.includes(pkg.version), `索引要包含当前版本 ${pkg.version}`)
  assert.equal(new Set(versions).size, versions.length, '版本不能重复')
  const descending = [...versions].sort((a, b) => compareSemver(b, a))
  assert.deepEqual(versions, descending, '版本按降序排列')
  assert.equal(entry.versions[0].version, versions[0], '第一条就是最高版本')
  for (const v of entry.versions) {
    assert.equal(v.source.type, 'npm', '当前用 npm 源')
    assert.ok(Number.isInteger(v.publishTimestamp) && v.publishTimestamp > 0, 'publishTimestamp 是 Unix 秒整数')
    assert.ok(/^[\^~<>=*|.\s\d.xA-Za-z-]+$/.test(v.engines.dsh ?? ''), 'engines.dsh 要是 SemVer 区间')
  }
  assert.equal(entry.versions[0].engines.dsh, pkg.engines.dsh, '索引与 package.json 的 engines.dsh 一致')
})

test('市场索引：图标内联为 data URL，解码不超过 32 KiB', () => {
  const entry = index.plugins[0]
  assert.ok(entry.icon?.startsWith('data:image/svg+xml;base64,'), '图标要内联成 data URL（避免 raw.githubusercontent 的 nosniff 拦图片）')
  const payload = entry.icon.slice('data:image/svg+xml;base64,'.length)
  const bytes = Buffer.from(payload, 'base64')
  assert.ok(bytes.length > 100, '图标不能是空的')
  assert.ok(bytes.length <= MAX_INLINE_ICON_BYTES, `图标 ${bytes.length} 字节超过 ${MAX_INLINE_ICON_BYTES}`)
  assert.equal(bytes.toString('utf8'), iconSvg, '内联图标应与 docs/icon.svg 一致')
})

test('账号迁移：仓库地址全部指向新账号，且没有旧账号残留', () => {
  assert.equal(config.owner, 'SiriusYANG91', 'market.config.json 的 owner 应已改名')
  assert.equal(config.repository, 'https://github.com/SiriusYANG91/dsh-astro-plan')
  assert.ok(pkg.repository.url.includes('SiriusYANG91/dsh-astro-plan'), 'package.json repository 应指向新仓库')
  assert.equal(pkg.homepage, 'https://github.com/SiriusYANG91/dsh-astro-plan#readme')
  for (const file of ['README.md', 'docs/user-guide.md', 'screenshots.json', 'awesome-entry.yml']) {
    const text = readFileSync(join(ROOT, file), 'utf8')
    assert.ok(!/beyangyi|sirius-yang/u.test(text), `${file} 不应再出现旧账号`)
  }
})

test('版本：package.json 与 README / 指南 / 索引一致为 0.2.2', () => {
  assert.equal(pkg.version, '0.2.2')
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  assert.ok(readme.includes('dsh-astro-plan@0.2.2'), 'README 安装命令应为 0.2.2')
  assert.ok(!readme.includes('0.29.0'), 'README 不应残留旧版本号')
  const guide = readFileSync(join(ROOT, 'docs', 'user-guide.md'), 'utf8')
  assert.ok(guide.includes('0.2.2'), '指南应写 0.2.2')
  assert.equal(index.plugins[0].versions[0].version, '0.2.2', '索引最新版本应为 0.2.2')
})

test('可发布：非 private、公开访问、包里带齐 lib 与 patch', () => {
  assert.notEqual(pkg.private, true, 'package.json 不能是 private')
  if (pkg.name.startsWith('@')) assert.equal(pkg.publishConfig?.access, 'public', 'scoped 包要显式 publishConfig.access = public')
  else assert.notEqual(pkg.private, true, '无 scope 的包默认公开发布')
  assert.ok(/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u.test(pkg.name), `包名要合法：${pkg.name}`)
  assert.ok(pkg.engines?.node && pkg.engines?.dsh, '要有 engines.node 与 engines.dsh')
  const files = pkg.files ?? []
  assert.ok(files.includes('lib/**/*.js'), 'files 要包含 lib 代码')
  assert.ok(files.includes('lib/data/*.json'), 'files 要包含数据')
  assert.ok(files.includes('cordis.patch.yml'), 'files 要包含 bundle patch')
  assert.ok(files.includes('LICENSE'), 'files 要包含 LICENSE')
  assert.ok(existsSync(join(ROOT, 'LICENSE')), 'LICENSE 文件要存在')
})

test('令牌不会被提交：.gitignore 含 .npmrc，且 .npmrc 不在 files 白名单', () => {
  const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8')
  assert.match(ignore, /^\.npmrc$/m, '.gitignore 要忽略 .npmrc')
  assert.match(ignore, /^\.npm-cache\/$/m, '.gitignore 要忽略 npm 缓存')
  assert.ok(existsSync(join(ROOT, '.npmrc.example')), '要提供 .npmrc.example 模板')
  assert.ok(!(pkg.files ?? []).some((f) => f.includes('npmrc')), 'files 白名单不能包含 .npmrc')
})

test('索引推送：脚本就位，GitHub 令牌同样不进 git', () => {
  const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8')
  assert.match(ignore, /^\.github-token$/m, '.gitignore 要忽略 .github-token')
  assert.ok(existsSync(join(ROOT, '.github-token.example')), '要提供 .github-token.example 模板')
  const script = readFileSync(join(ROOT, 'tools', 'push-market-index.mjs'), 'utf8')
  assert.ok(script.includes('/contents/'), '推送脚本要走 GitHub Contents API')
  assert.ok(script.includes('validateMarketIndex'), '推送前要再校验一次索引')
})

test('生成器幂等：固定时间戳时两次输出完全一致', () => {
  const now = 1794000000000
  const a = buildMarketIndex({ pkg, config, iconSvg, previous: null, now })
  const b = buildMarketIndex({ pkg, config, iconSvg, previous: null, now })
  assert.equal(JSON.stringify(a.doc), JSON.stringify(b.doc))
  // 已有同版本时保留原时间戳（发版脚本用 --publish-now 才会刷新）
  const kept = buildMarketIndex({ pkg, config, iconSvg, previous: a.doc, now: now + 1e6 })
  assert.equal(kept.doc.plugins[0].versions.find((v) => v.version === pkg.version).publishTimestamp, Math.floor(now / 1000))
  // 旧版本要保留
  const older = JSON.parse(JSON.stringify(a.doc))
  older.plugins[0].versions.push({ version: '0.0.1', publishTimestamp: 1700000000, source: { type: 'npm' }, engines: { dsh: pkg.engines.dsh } })
  const kept2 = buildMarketIndex({ pkg, config, iconSvg, previous: older, now })
  const versions = kept2.doc.plugins[0].versions.map((v) => v.version)
  assert.ok(versions.includes('0.0.1'), '历史版本不能丢')
  assert.equal(versions[0], pkg.version, '新版本排在最前')
})

test('仓库占位符：索引省略 homepage/repository，体检会提示缺项', () => {
  assert.equal(isPlaceholder(''), true)
  assert.equal(isPlaceholder('https://github.com/REPLACE-ME/dsh-astro-plan'), true)
  assert.equal(isPlaceholder('https://github.com/SiriusYANG91/dsh-astro-plan'), false)
  assert.equal(repoUrls({ owner: '', repository: '' }), null)
  const urls = repoUrls({ owner: 'SiriusYANG91', repository: 'https://github.com/SiriusYANG91/dsh-astro-plan' })
  assert.equal(urls.indexUrl, INDEX_URL, 'raw 索引地址要按 owner/repo 拼出来')
  const draft = buildMarketIndex({ pkg, config: { ...config, owner: '', repository: '' }, iconSvg, previous: null, now: 1794000000000 })
  assert.equal(draft.missing.length, 1, '占位符要报缺项')
  assert.ok(!('repository' in draft.doc.plugins[0]) && !('homepage' in draft.doc.plugins[0]))
  assert.equal(svgDataUrl(iconSvg).startsWith('data:image/svg+xml;base64,'), true)
})
