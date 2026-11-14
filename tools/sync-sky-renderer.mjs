/**
 * 把 `lib/skyview.js` 的 RENDER_SRC 与 `lib/mapview.js` 的 MAP_SRC 同步进 `lib/client.js`
 * 的标记之间（缩进 4 空格）。页面脚本直接内联这两段源码；会话 Tab 是浏览器 bundle，
 * 不能 import，因此保留副本，由本脚本生成。
 *
 * 改动渲染器或地图组件后运行：node tools/sync-sky-renderer.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { RENDER_SRC } from '../lib/skyview.js'
import { MAP_SRC } from '../lib/mapview.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const clientPath = join(HERE, '..', 'lib', 'client.js')

function replaceBlock(source, startMarker, endMarker, payload, label) {
  const a = source.indexOf(startMarker)
  const b = source.indexOf(endMarker)
  if (a < 0 || b < 0 || b <= a) throw new Error(`client.js 里找不到 ${label} 标记`)
  const indented = payload
    .split('\n')
    .map((line) => (line ? `    ${line}` : line))
    .join('\n')
  return source.slice(0, a + startMarker.length) + '\n' + indented + '\n' + source.slice(b)
}

let src = readFileSync(clientPath, 'utf8')
src = replaceBlock(src, '    /* === MAP VIEW START === */', '    /* === MAP VIEW END === */', MAP_SRC, 'MAP VIEW')
src = replaceBlock(src, '    /* === SKY RENDERER START === */', '    /* === SKY RENDERER END === */', RENDER_SRC, 'SKY RENDERER')
writeFileSync(clientPath, src)
console.log(`同步地图 ${MAP_SRC.length} 字节 + 渲染器 ${RENDER_SRC.length} 字节 → lib/client.js`)
