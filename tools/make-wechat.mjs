/**
 * 把 `docs/user-guide.md` 导出成适合微信公众号粘贴的内容：
 *
 *   1. `docs/wechat/guide.html` —— 全部样式内联（公众号会丢掉 <style> 与 class），
 *      在浏览器里打开后全选复制，粘贴进公众号编辑器即可保留排版；
 *   2. `docs/wechat/README.md` —— 发布指引、标题/摘要候选、配图清单与替换顺序；
 *   3. 配图按发布顺序复制到 `docs/wechat/images/`（公众号必须自己上传图片）。
 *
 * 用法：node tools/make-wechat.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, existsSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const OUT = join(ROOT, 'docs', 'wechat')
const GUIDE = join(ROOT, 'docs', 'user-guide.md')

/** 公众号正文的基准样式：白底、16px、1.75 行高、深灰字。 */
const FONT = "font-size:16px;line-height:1.75;color:#3f3f3f;letter-spacing:.4px;"
const TITLE = '星野计划：把「去哪拍、什么时候拍、怎么拍」一次算清'

const escapeHtml = (text) => text
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')

/** 行内语法：`code`、**bold**、[text](url)。 */
function inline(text) {
  const parts = []
  let rest = text
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)]+)\)/u
  for (;;) {
    const match = pattern.exec(rest)
    if (!match) { parts.push(escapeHtml(rest)); break }
    parts.push(escapeHtml(rest.slice(0, match.index)))
    if (match[1] !== undefined) {
      parts.push(`<code style="background:#f4f5f7;color:#c7254e;padding:1px 5px;border-radius:3px;font-size:14px;font-family:Menlo,Consolas,monospace;">${escapeHtml(match[1])}</code>`)
    } else if (match[2] !== undefined) {
      parts.push(`<strong style="color:#1f2329;font-weight:600;">${inline(match[2])}</strong>`)
    } else if (match[3] !== undefined) {
      parts.push(`<em style="font-style:italic;color:#6b7280;">${inline(match[3])}</em>`)
    } else {
      const url = match[5]
      if (url.startsWith('#')) {
        // 页内锚点在公众号里点不动，直接给纯文本，别染成链接色
        parts.push(inline(match[4]))
      } else {
        const external = /^https?:/u.test(url)
        parts.push(`<a href="${escapeHtml(url)}" style="color:#576b95;text-decoration:none;border-bottom:1px solid #d6dbe4;">${inline(match[4])}</a>`)
        if (external) parts.push(`<span style="color:#9aa4b2;font-size:12px;">（${escapeHtml(new URL(url).hostname)}）</span>`)
      }
    }
    rest = rest.slice(match.index + match[0].length)
  }
  return parts.join('')
}

const H2 = 'margin:34px 0 14px;padding:8px 0 8px 12px;border-left:4px solid #d8b46a;font-size:19px;font-weight:700;color:#1f2329;line-height:1.5;'
const H3 = 'margin:24px 0 10px;font-size:16.5px;font-weight:700;color:#1f2329;line-height:1.5;'
const P = `margin:14px 0;${FONT}`
const UL = 'margin:14px 0;padding-left:1.3em;'
const LI = `margin:7px 0;${FONT}`
const PRE = 'margin:16px 0;padding:14px 16px;background:#f7f8fa;border-left:3px solid #d8b46a;border-radius:6px;overflow-x:auto;font-size:13px;line-height:1.7;color:#2f3640;font-family:Menlo,Consolas,monospace;white-space:pre;'
const TABLE = 'width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;line-height:1.7;'
const TH = 'padding:9px 10px;background:#f6f7f9;border:1px solid #e6e8eb;color:#1f2329;font-weight:600;text-align:left;'
const TD = 'padding:9px 10px;border:1px solid #e6e8eb;color:#3f3f3f;vertical-align:top;'
const QUOTE = 'margin:18px 0;padding:14px 16px;background:#faf7f0;border-left:3px solid #d8b46a;border-radius:6px;color:#5a5346;font-size:15px;line-height:1.8;'

/** 逐块解析 Markdown：只覆盖指南实际用到的语法。 */
function convert(markdown) {
  const lines = markdown.split(/\r?\n/u)
  const html = []
  const images = []
  let i = 0
  let inCode = false
  let codeLines = []
  let listType = null
  let tableRows = null

  const closeList = () => { if (listType) { html.push(`</${listType}>`); listType = null } }
  const flushTable = () => {
    if (!tableRows) return
    const [head, ...body] = tableRows
    const bodyRows = body.filter((row) => !row.every((cell) => /^:?-{2,}:?$/u.test(cell.trim())))
    html.push(`<table style="${TABLE}">`)
    html.push('<thead><tr>' + head.map((cell) => `<th style="${TH}">${inline(cell.trim())}</th>`).join('') + '</tr></thead>')
    if (bodyRows.length) {
      html.push('<tbody>' + bodyRows.map((row) => '<tr>' + row.map((cell) => `<td style="${TD}">${inline(cell.trim())}</td>`).join('') + '</tr>').join('') + '</tbody>')
    }
    html.push('</table>')
    tableRows = null
  }

  for (; i < lines.length; i += 1) {
    const line = lines[i]
    const fence = /^```/u.test(line)
    if (inCode) {
      if (fence) {
        html.push(`<pre style="${PRE}"><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
        inCode = false
        codeLines = []
      } else codeLines.push(line)
      continue
    }
    if (fence) { closeList(); flushTable(); inCode = true; codeLines = []; continue }

    if (/^\|/u.test(line)) { closeList(); (tableRows ??= []).push(line.split('|').slice(1, -1)); continue }
    flushTable()

    if (/^#{1,6} /u.test(line)) {
      closeList()
      const level = /^#+/u.exec(line)[0].length
      const text = line.replace(/^#+\s+/u, '')
      if (level === 1) continue // 标题单独处理，正文不重复
      html.push(level === 2
        ? `<h2 style="${H2}">${inline(text)}</h2>`
        : `<h3 style="${H3}">${inline(text)}</h3>`)
      continue
    }
    if (/^!\[/u.test(line)) {
      closeList()
      const match = /^!\[([^\]]*)\]\(([^)]+)\)/u.exec(line)
      if (!match) continue
      const file = basename(match[2])
      const caption = match[1]
      images.push({ file, caption, source: join(ROOT, 'docs', 'images', file) })
      html.push(`<p style="margin:20px 0 6px;text-align:center;"><img src="images/${file}" alt="${escapeHtml(caption)}" style="max-width:100%;border-radius:8px;display:block;margin:0 auto;" /></p>`)
      html.push(`<p style="margin:0 0 18px;text-align:center;font-size:13px;color:#9aa4b2;line-height:1.6;">${escapeHtml(caption)}</p>`)
      continue
    }
    if (/^> /u.test(line)) { closeList(); html.push(`<section style="${QUOTE}">${inline(line.replace(/^> /u, ''))}</section>`); continue }
    if (/^---+$/u.test(line)) { closeList(); html.push('<p style="margin:26px 0;text-align:center;color:#d8b46a;letter-spacing:8px;">· · ·</p>'); continue }
    if (/^[-*] /u.test(line)) {
      if (listType !== 'ul') { closeList(); html.push(`<ul style="${UL}">`); listType = 'ul' }
      html.push(`<li style="${LI}">${inline(line.slice(2))}</li>`)
      continue
    }
    if (/^\d+\. /u.test(line)) {
      if (listType !== 'ol') { closeList(); html.push(`<ol style="${UL}">`); listType = 'ol' }
      html.push(`<li style="${LI}">${inline(line.replace(/^\d+\. /u, ''))}</li>`)
      continue
    }
    if (line.trim() === '') { closeList(); continue }
    closeList()
    html.push(`<p style="${P}">${inline(line)}</p>`)
  }
  if (inCode && codeLines.length) html.push(`<pre style="${PRE}"><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
  flushTable()
  closeList()
  return { body: html.join('\n'), images }
}

const guide = readFileSync(GUIDE, 'utf8')
const { body, images } = convert(guide)

const intro = `<section style="margin:0 0 20px;padding:0 0 0 0;${FONT}">
<p style="margin:0 0 10px;font-size:15px;color:#8a94a6;letter-spacing:.5px;">星野计划 · 用户指南（公众号版）</p>
<p style="margin:0;${FONT}">${inline('这份指南按「查询 → 结果 → 便签 → 参数 → 画面模拟 → 数据」的顺序介绍全部功能，配 9 张真实界面截图。适合收藏后按图索骥。')}</p>
</section>`

const footer = `<section style="margin:34px 0 0;padding-top:18px;border-top:1px solid #e6e8eb;${FONT}">
<p style="margin:0 0 8px;font-size:14px;color:#8a94a6;">星野计划（dsh-astro-plan）· 作者 Sirius YANG · MIT 许可</p>
<p style="margin:0;font-size:14px;color:#8a94a6;">开源地址：<a href="https://github.com/SiriusYANG91/dsh-astro-plan" style="color:#576b95;text-decoration:none;">github.com/SiriusYANG91/dsh-astro-plan</a></p>
</section>`

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${TITLE}</title>
</head>
<body style="margin:0;padding:0;background:#fff;">
<article id="wechat-article" style="max-width:677px;margin:0 auto;padding:20px 16px 40px;background:#fff;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;${FONT}">
<h1 style="margin:0 0 18px;font-size:22px;line-height:1.5;font-weight:700;color:#1f2329;">${TITLE}</h1>
${intro}
${body}
${footer}
</article>
</body>
</html>
`

mkdirSync(OUT, { recursive: true })
rmSync(join(OUT, 'images'), { recursive: true, force: true })
mkdirSync(join(OUT, 'images'), { recursive: true })
for (const image of images) {
  if (!existsSync(image.source)) throw new Error(`缺图：${image.source}`)
  copyFileSync(image.source, join(OUT, 'images', image.file))
}
writeFileSync(join(OUT, 'guide.html'), html)

const summary = '按 18 类天象与深空目标、全国 173 站、最长一年检索，结合光污染、方位、月相与 7 天天气，给出推荐排序、焦段与曝光，并附 Stellarium 风格 3D 天球画面模拟。'
const readme = `# 公众号发布指引

本目录是《星野计划 · 用户指南》的公众号版本，由 \`node tools/make-wechat.mjs\` 从 \`docs/user-guide.md\` 生成（改指南后重跑即可）。

## 两个文件怎么用

| 文件 | 用途 |
|---|---|
| \`guide.docx\` | **推荐**。用 Word 打开 → 全选复制 → 粘贴进公众号编辑器：排版与 9 张图会一起过去（图片会被公众号自动上传）。 |
| \`guide.html\` | 浏览器打开 → 全选复制 → 粘贴进编辑器。**图片不会被带过去**，需按下面的顺序用编辑器的「图片」按钮逐张上传。 |
| \`images/\` | 按发布顺序命名的配图，供 HTML 路线手动上传。 |

## 标题候选

1. ${TITLE}
2. 拍星去哪、几时拍、怎么拍：一个插件全算清
3. 全国 173 个拍星点 + 3D 天球模拟：星野计划使用指南

## 摘要（≤120 字，可直接粘贴）

${summary}

## 配图清单（按正文出现顺序）

${images.map((image, index) => `${index + 1}. \`images/${image.file}\` —— ${image.caption}`).join('\n')}

## 发布检查

- [ ] 正文第一段与本目录 \`guide.html\` 一致（标题、导语、结尾开源地址）
- [ ] 9 张配图都已上传，且紧随对应小节（公众号不支持 Markdown 图注，图注已写成正文小字）
- [ ] 表格已转成公众号支持的简单表格（\`guide.docx\` 路线自带边框样式）
- [ ] 文末「开源地址」保留为纯文本 + 链接（公众号正文里的外链不能点击，但保留可读性）
- [ ] 原创声明、作者「Sirius YANG」、话题标签（摄影 / 天文 / 工具）

## 注意

- 公众号会丢弃 \`<style>\`、\`class\` 与 \`id\`，所以本文件所有样式都写成内联 \`style="..."\`，不要改成外部 CSS。
- 正文宽度固定 677px（公众号标准），配图原宽 1400–1570px，会被等比缩到 100%。
- 代码块已转成等宽字体的浅底段落，粘贴后若丢背景色，用编辑器的「代码块」样式重设一次即可。
`
writeFileSync(join(OUT, 'README.md'), readme)

console.log(`✓ 写出 ${join(OUT, 'guide.html')}（${(html.length / 1024).toFixed(0)} KB，${images.length} 张图）`)
console.log(`✓ 写出 ${join(OUT, 'README.md')}`)
console.log(`✓ 复制 ${images.length} 张配图到 docs/wechat/images/`)
