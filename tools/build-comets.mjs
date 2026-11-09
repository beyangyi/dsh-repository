/**
 * 生成 lib/data/comets.json（手动重建彗星库）。
 *
 * 用法：node tools/build-comets.mjs
 *
 * 解析、筛选与亮度模型都在 lib/database.js 里，运行时「每周首次启动自动更新」
 * 走的是同一套代码（database.refreshDatabase），本脚本只是把结果写到磁盘上，
 * 保证手工重建与自动更新产出的文件完全一致。
 */

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MPC_URL, buildCometCatalog } from '../lib/database.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'lib', 'data', 'comets.json')

async function main() {
  const res = await fetch(MPC_URL)
  if (!res.ok) throw new Error(`MPC ${res.status}`)
  const text = await res.text()
  const catalog = await buildCometCatalog(text, { log: (line) => console.log(line) })
  writeFileSync(OUT, `${JSON.stringify(catalog, null, 1)}\n`)
  const first = catalog.comets[0]
  const last = catalog.comets[catalog.comets.length - 1]
  console.log(`保留 ${catalog.count} 颗（最亮 ${first?.minMag} 等 / 最暗 ${last?.minMag} 等）`)
  console.log(`写入 ${OUT}`)
}

// 允许被测试/调试脚本导入而不触发网络请求
if (process.env.AP_BUILD_COMETS !== 'off') {
  main().catch((error) => { console.error(error); process.exit(1) })
}
