import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WECHAT = join(ROOT, 'docs', 'wechat')

const html = readFileSync(join(WECHAT, 'guide.html'), 'utf8')
const readme = readFileSync(join(WECHAT, 'README.md'), 'utf8')
const guide = readFileSync(join(ROOT, 'docs', 'user-guide.md'), 'utf8')

test('公众号 HTML：只保留公众号认得的写法（无 <style>、无 class、无脚本）', () => {
  assert.ok(!/<style[\s>]/iu.test(html), '不能有 <style> 块，公众号会丢弃')
  assert.ok(!/\sclass=/u.test(html), '不能依赖 class，公众号会丢弃')
  assert.ok(!/<script/iu.test(html), '不能有脚本')
  assert.ok(!/<link[\s>]/iu.test(html), '不能有外部样式表')
  const inline = (html.match(/style="/gu) ?? []).length
  assert.ok(inline > 150, `内联样式只有 ${inline} 处，排版会塌`)
  assert.match(html, /max-width:677px/u, '正文容器应按公众号宽度 677px')
})

test('公众号 HTML：9 张配图都指向本地 images/，没有外链图片', () => {
  const images = [...html.matchAll(/<img[^>]+src="([^"]+)"/gu)].map((m) => m[1])
  assert.equal(images.length, 9, `配图应为 9 张，实际 ${images.length}`)
  for (const src of images) assert.ok(src.startsWith('images/'), `图片不能外链：${src}`)
  const files = readdirSync(join(WECHAT, 'images')).filter((name) => name.endsWith('.png'))
  assert.equal(files.length, 9, 'images/ 目录应复制 9 张图')
  for (const src of images) assert.ok(existsSync(join(WECHAT, src)), `缺图：${src}`)
})

test('公众号 HTML：章节、表格、代码块与要点都在', () => {
  for (const title of ['三种入口', '查询区', '结果列表', '展开详情', '画面模拟', '评分模型', '数据与更新', '术语表']) {
    assert.ok(html.includes(`>${title}<`) || html.includes(title), `缺少章节：${title}`)
  }
  assert.ok((html.match(/<table /gu) ?? []).length >= 8, '表格应转成 <table>')
  assert.ok((html.match(/<pre /gu) ?? []).length >= 3, '代码块应转成 <pre>')
  assert.ok(html.includes('星野计划（dsh-astro-plan）'), '缺少文末署名')
})

test('公众号 HTML：内容与指南同步（图片顺序与标题一致）', () => {
  const guideImages = [...guide.matchAll(/^!\[([^\]]*)\]\((images\/[^)]+)\)/gmu)].map((m) => m[2])
  const htmlImages = [...html.matchAll(/<img[^>]+src="images\/([^"]+)"/gu)].map((m) => `images/${m[1]}`)
  assert.deepEqual(htmlImages, guideImages, 'HTML 的配图顺序应与指南一致')
  const headings = [...guide.matchAll(/^## \d+\. (.+)$/gmu)].map((m) => m[1])
  for (const heading of headings) assert.ok(html.includes(heading), `HTML 缺少小节：${heading}`)
})

test('公众号 README：发布步骤、标题/摘要候选与配图清单齐全', () => {
  for (const keyword of ['guide.docx', 'guide.html', '标题候选', '摘要', '配图清单', '发布检查']) {
    assert.ok(readme.includes(keyword), `README 缺少：${keyword}`)
  }
  const listed = (readme.match(/images\/[0-9a-z-]+\.png/gu) ?? []).length
  assert.ok(listed >= 9, `配图清单应列 9 张，实际 ${listed}`)
  const summary = readme.split('\n').find((line) => line.startsWith('按 18 类天象'))
  assert.ok(summary, '应给出可直接粘贴的摘要')
  assert.ok(summary.length <= 120, `摘要 ${summary.length} 字，公众号限 120 字内`)
})

test('公众号 Word：已生成、是有效 docx、体积足够（含图）', () => {
  const file = join(WECHAT, 'guide.docx')
  assert.ok(existsSync(file), '缺 guide.docx（先跑 python tools/make-wechat-docx.py）')
  const buffer = readFileSync(file)
  assert.equal(buffer.subarray(0, 2).toString('latin1'), 'PK', 'docx 应为 zip 包')
  assert.ok(buffer.length > 800 * 1024, `docx 只有 ${Math.round(buffer.length / 1024)} KB，图可能没嵌进去`)
})

test('公众号导出：生成脚本与 README 入口都在', () => {
  assert.ok(existsSync(join(ROOT, 'tools', 'make-wechat.mjs')), '缺 tools/make-wechat.mjs')
  assert.ok(existsSync(join(ROOT, 'tools', 'make-wechat-docx.py')), '缺 tools/make-wechat-docx.py')
  assert.ok(existsSync(join(ROOT, 'docs', 'wechat', 'guide.html')), '缺 docs/wechat/guide.html')
  assert.ok(readFileSync(join(ROOT, 'README.md'), 'utf8').includes('make-wechat'), '主 README 的开发命令里应提到公众号导出')
})
