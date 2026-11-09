/**
 * 插件市场索引 format 1 的离线校验器。
 *
 * 规则与 DSH 自带的 `@deepseek-ai/dsh-plugin-market-index`（在 app.asar 里）一致：
 * 顶层 `format` 必须是 1，`title` 必须带 `en`，`plugins` 是数组且名字不重复，
 * 每个版本的 `version` 是精确 SemVer、`publishTimestamp` 是 Unix 秒整数、
 * `source` 只能是 npm / git 两种形状，`icon` 只能是 https URL 或 ≤32 KiB 的 data URL。
 *
 * 用法：`node tools/validate-market-index.mjs [docs/market-index.json]`
 * 退出码非 0 表示不合法；也可以 `import { validateMarketIndex }` 在测试里用。
 */

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u
const PACKAGE_NAME_MAX_LENGTH = 214
const NUMERIC = '(?:0|[1-9]\\d*)'
const PRERELEASE_PART = `(?:${NUMERIC}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`
const SEMVER = new RegExp(`^${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}(?:-${PRERELEASE_PART}(?:\\.${PRERELEASE_PART})*)?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`, 'u')
const COMMIT = /^[0-9a-f]{40}$/u
const LANGUAGE_ID = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u
const PATH_SEGMENT = /^[A-Za-z0-9._@+-]+$/u
const DATA_ICON = /^data:(?:image\/svg\+xml|image\/png|image\/jpeg|image\/webp);base64,([A-Za-z0-9+/]*={0,2})$/u
const MAX_INLINE_ICON_BYTES = 32 * 1024
const MAX_PUBLISH_TIMESTAMP = 1e11

class MarketIndexError extends Error {
  constructor(path, reason) {
    super(`${path} ${reason}`)
    this.path = path
    this.reason = reason
    this.name = 'MarketIndexError'
  }
}

const fail = (path, reason) => { throw new MarketIndexError(path, reason) }

function objectAt(value, path) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, '必须是对象')
  return value
}

function stringAt(value, path) {
  if (typeof value !== 'string' || value.trim() === '') fail(path, '必须是非空字符串')
  return value
}

const optional = (object, key, path, read) => (Object.hasOwn(object, key) ? read(object[key], `${path}.${key}`) : undefined)

function localizedText(value, path) {
  if (typeof value === 'string') return stringAt(value, path)
  const object = objectAt(value, path)
  const text = {}
  for (const [language, member] of Object.entries(object)) {
    if (!LANGUAGE_ID.test(language)) fail(`${path}.${language}`, '语言键必须是小写语言 id')
    text[language] = stringAt(member, `${path}.${language}`)
  }
  if (!Object.hasOwn(text, 'en')) fail(path, '必须包含 en')
  return text
}

function declarations(value, path, read) {
  const result = {}
  for (const [id, member] of Object.entries(objectAt(value, path))) {
    if (id === '') fail(path, 'id 不能为空')
    result[id] = read(objectAt(member, `${path}.${id}`), `${path}.${id}`)
  }
  return result
}

const declaration = (object, path) => ({ title: localizedText(object.title, `${path}.title`) })

function sortKeyDeclaration(object, path) {
  if (object.order !== 'asc' && object.order !== 'desc') fail(`${path}.order`, '必须是 "asc" 或 "desc"')
  return { title: localizedText(object.title, `${path}.title`), order: object.order }
}

function indexMetadata(value, path) {
  const object = value === undefined ? {} : objectAt(value, path)
  return {
    categories: optional(object, 'categories', path, (m, at) => declarations(m, at, declaration)) ?? {},
    labels: optional(object, 'labels', path, (m, at) => declarations(m, at, declaration)) ?? {},
    sortKeys: optional(object, 'sortKeys', path, (m, at) => declarations(m, at, sortKeyDeclaration)) ?? {},
  }
}

function declaredId(value, path, declared) {
  const id = stringAt(value, path)
  if (!Object.hasOwn(declared, id)) fail(path, `引用了未声明的 id ${JSON.stringify(id)}`)
  return id
}

function pluginMetadata(value, path, index) {
  const object = value === undefined ? {} : objectAt(value, path)
  const category = optional(object, 'category', path, (m, at) => declaredId(m, at, index.categories))
  const keywords = optional(object, 'keywords', path, (m, at) => (Array.isArray(m) ? m.map(stringAt0) : fail(at, '必须是数组'))) ?? []
  const labels = optional(object, 'labels', path, (m, at) => {
    if (!Array.isArray(m)) fail(at, '必须是数组')
    const ids = m.map((label, position) => declaredId(label, `${at}[${String(position)}]`, index.labels))
    if (new Set(ids).size !== ids.length) fail(at, '标签不能重复')
    return ids
  }) ?? []
  const sortKeys = optional(object, 'sortKeys', path, (m, at) => objectAt(m, at)) ?? {}
  return {
    ...(category === undefined ? {} : { category }),
    keywords,
    labels,
    sortKeys,
  }
}

function stringAt0(value, position) {
  if (typeof value !== 'string') fail(`$.plugins.keywords[${String(position)}]`, '必须是字符串')
  return value
}

function httpUrl(value, path, protocols) {
  const text = stringAt(value, path)
  let url
  try { url = new URL(text) } catch { fail(path, '必须是绝对 URL') }
  if (!protocols.includes(url.protocol)) fail(path, `必须使用 ${protocols.join(' 或 ')}`)
  if (url.username !== '' || url.password !== '') fail(path, '不能带凭据')
  if (url.href.includes('?') || url.href.includes('#')) fail(path, '不能带查询串或片段')
  return url
}

function homepageUrl(value, path) {
  const text = stringAt(value, path)
  if (!URL.canParse(text)) fail(path, '必须是绝对 URL')
  const url = new URL(text)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') fail(path, '必须使用 https: 或 http:')
  return url.href
}

function repository(value, path) {
  const object = objectAt(value, path)
  const url = httpUrl(object.url, `${path}.url`, ['https:', 'http:']).href
  const directory = optional(object, 'directory', path, (m, at) => {
    const text = stringAt(m, at)
    if (text.split('/').some((s) => s === '.' || s === '..' || !PATH_SEGMENT.test(s))) fail(at, '必须是相对目录')
    return text
  })
  return { url, ...(directory === undefined ? {} : { directory }) }
}

function source(value, path) {
  const object = objectAt(value, path)
  if (object.type === 'npm') {
    const registry = optional(object, 'registry', path, (m, at) => httpUrl(m, at, ['https:', 'http:']).href)
    return { type: 'npm', ...(registry === undefined ? {} : { registry }) }
  }
  if (object.type === 'git') {
    const commit = stringAt(object.commit, `${path}.commit`)
    if (!COMMIT.test(commit)) fail(`${path}.commit`, '必须是 40 位小写十六进制 commit')
    const url = httpUrl(object.url, `${path}.url`, ['https:'])
    if (url.href !== object.url) fail(`${path}.url`, '必须是规范 URL')
    const packagePath = optional(object, 'path', path, (m, at) => {
      const text = stringAt(m, at)
      if (text.split('/').some((s) => s === '.' || s === '..' || !PATH_SEGMENT.test(s))) fail(at, '必须是相对目录')
      return text
    })
    return { type: 'git', url: url.href, commit, ...(packagePath === undefined ? {} : { path: packagePath }) }
  }
  return fail(`${path}.type`, '必须是 "npm" 或 "git"')
}

function engines(value, path) {
  const object = objectAt(value, path)
  const dsh = optional(object, 'dsh', path, (m, at) => {
    const range = stringAt(m, at)
    if (range.startsWith('workspace:')) fail(at, '不能是 workspace: 区间')
    if (!/^[\^~<>=*|.\s\d.xA-Za-z-]+$/u.test(range)) fail(at, '必须是 SemVer 区间')
    return range
  })
  return dsh === undefined ? {} : { dsh }
}

export function iconDataUrl(value, path, indexUrl) {
  const text = stringAt(value, path)
  if (text.startsWith('data:')) {
    const payload = DATA_ICON.exec(text)?.[1]
    if (payload === undefined || payload === '') fail(path, '必须是 base64 的 SVG/PNG/JPEG/WebP data URL')
    const decoded = (payload.length / 4) * 3 - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0)
    if (decoded > MAX_INLINE_ICON_BYTES) fail(path, `解码后不能超过 ${MAX_INLINE_ICON_BYTES / 1024} KiB`)
    return { url: text, bytes: decoded }
  }
  const resolved = new URL(text, indexUrl)
  if (resolved.protocol !== 'https:' && resolved.origin !== new URL(indexUrl).origin) fail(path, '必须解析为 https 或与索引同源')
  return { url: resolved.href, bytes: 0 }
}

function marketVersion(value, path) {
  const object = objectAt(value, path)
  const version = stringAt(object.version, `${path}.version`)
  if (!SEMVER.test(version)) fail(`${path}.version`, '必须是精确 SemVer')
  const publishTimestamp = object.publishTimestamp
  if (typeof publishTimestamp !== 'number' || !Number.isInteger(publishTimestamp) || publishTimestamp < 0 || publishTimestamp >= MAX_PUBLISH_TIMESTAMP) {
    fail(`${path}.publishTimestamp`, '必须是 [0, 10^11) 的 Unix 秒整数')
  }
  return {
    version,
    publishTimestamp,
    source: source(object.source, `${path}.source`),
    engines: optional(object, 'engines', path, engines) ?? {},
  }
}

function versions(value, path) {
  if (!Array.isArray(value) || value.length === 0) fail(path, '必须是非空数组')
  const seen = new Set()
  return value.map((member, position) => {
    const at = `${path}[${String(position)}]`
    const entry = marketVersion(member, at)
    if (seen.has(entry.version)) fail(`${at}.version`, `重复的 ${entry.version}`)
    seen.add(entry.version)
    return entry
  }).sort((a, b) => compareSemver(b.version, a.version))
}

/** 只用于排序的简易 SemVer 比较（与 semver.rcompare 同序）。 */
export function compareSemver(a, b) {
  const parse = (v) => {
    const [core, pre] = v.split('+')[0].split('-')
    const [major, minor, patch] = core.split('.').map(Number)
    return { major, minor, patch, pre: pre ? pre.split('.') : null }
  }
  const pa = parse(a)
  const pb = parse(b)
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] - pb[key]
  }
  if (pa.pre === null && pb.pre === null) return 0
  if (pa.pre === null) return 1
  if (pb.pre === null) return -1
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i += 1) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x) ? Number(x) : null
    const ny = /^\d+$/.test(y) ? Number(y) : null
    if (nx !== null && ny !== null) { if (nx !== ny) return nx - ny; continue }
    if (nx !== null) return -1
    if (ny !== null) return 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

function plugin(value, path, index, indexUrl) {
  const object = objectAt(value, path)
  const name = stringAt(object.name, `${path}.name`)
  if (name.length > PACKAGE_NAME_MAX_LENGTH || !PACKAGE_NAME.test(name)) fail(`${path}.name`, '必须是合法的 npm 包名')
  const title = optional(object, 'title', path, localizedText)
  const description = optional(object, 'description', path, localizedText)
  const iconUrl = optional(object, 'icon', path, (m, at) => iconDataUrl(m, at, indexUrl).url)
  const author = optional(object, 'author', path, stringAt)
  const homepage = optional(object, 'homepage', path, homepageUrl)
  const repo = optional(object, 'repository', path, repository)
  return {
    name,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(iconUrl === undefined ? {} : { icon: iconUrl }),
    ...(author === undefined ? {} : { author }),
    ...(homepage === undefined ? {} : { homepage }),
    ...(repo === undefined ? {} : { repository: repo }),
    metadata: pluginMetadata(object.metadata, `${path}.metadata`, index),
    versions: versions(object.versions, `${path}.versions`),
  }
}

/**
 * 校验一份 format 1 索引。
 * @param {unknown} value 已解析的 JSON
 * @param {string} indexUrl 索引自身的绝对 URL（相对图标按它解析）
 * @returns {{format: 1, title: unknown, plugins: unknown[]}} 校验后的索引
 */
export function validateMarketIndex(value, indexUrl = 'https://example.invalid/market-index.json') {
  if (!URL.canParse(indexUrl)) fail('$', `索引 URL ${JSON.stringify(indexUrl)} 必须是绝对 URL`)
  const object = objectAt(value, '$')
  if (object.format !== 1) fail('$.format', '必须是 1')
  const metadata = indexMetadata(object.metadata, '$.metadata')
  if (!Array.isArray(object.plugins)) fail('$.plugins', '必须是数组')
  const names = new Set()
  const plugins = object.plugins.map((entry, position) => {
    const parsed = plugin(entry, `$.plugins[${String(position)}]`, metadata, new URL(indexUrl))
    if (names.has(parsed.name)) fail(`$.plugins[${String(position)}].name`, `重复的 ${parsed.name}`)
    names.add(parsed.name)
    return parsed
  })
  const title = localizedText(object.title, '$.title')
  const description = optional(object, 'description', '$', localizedText)
  return { format: 1, title, ...(description === undefined ? {} : { description }), metadata, plugins }
}

export function formatIndexError(error) {
  return error instanceof MarketIndexError ? `${error.path} ${error.reason}` : String(error?.message ?? error)
}

export { MarketIndexError, MAX_INLINE_ICON_BYTES }

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href
if (isMain) {
  const { readFileSync } = await import('node:fs')
  const file = process.argv[2] ?? 'docs/market-index.json'
  const indexUrl = process.env.MARKET_INDEX_URL ?? 'https://raw.githubusercontent.com/owner/repo/main/docs/market-index.json'
  try {
    const doc = validateMarketIndex(JSON.parse(readFileSync(file, 'utf8')), indexUrl)
    const versions = doc.plugins.flatMap((p) => p.versions.map((v) => `${p.name}@${v.version}`))
    console.log(`✓ ${file} 合法：${doc.plugins.length} 个插件、${versions.length} 个版本`)
    for (const v of versions) console.log('  ·', v)
  } catch (error) {
    console.error(`✗ ${file} 不合法：${formatIndexError(error)}`)
    process.exit(1)
  }
}
