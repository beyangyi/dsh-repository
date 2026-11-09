/**
 * 把 lib/skyview.js 的 RENDER_SRC 同步进 lib/client.js 的标记之间（缩进 4 空格）。
 *
 * 页面脚本直接内联 RENDER_SRC；会话 Tab 是浏览器 bundle，不能 import，
 * 因此保留一份拷贝，由这个脚本生成、由 tests/sky.test.js 校验一致。
 * 改动 RENDER_SRC 后运行：node tools/sync-sky-renderer.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { RENDER_SRC } from '../lib/skyview.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const clientPath = join(HERE, '..', 'lib', 'client.js')

const START = '    /* === SKY RENDERER START === */'
const END = '    /* === SKY RENDERER END === */'

const src = readFileSync(clientPath, 'utf8')
const a = src.indexOf(START)
const b = src.indexOf(END)
if (a < 0 || b < 0 || b <= a) throw new Error('client.js 里找不到 SKY RENDERER 标记')

const indented = RENDER_SRC
  .split('\n')
  .map((line) => (line ? `    ${line}` : line))
  .join('\n')

const next = src.slice(0, a + START.length) + '\n' + indented + '\n' + src.slice(b)
writeFileSync(clientPath, next)
console.log(`同步渲染器 ${RENDER_SRC.length} 字节 → lib/client.js`)
