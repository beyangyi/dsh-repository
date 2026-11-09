/**
 * 数据库维护：MPC 彗星库解析、周更判断、后台刷新与失败降级。
 * 全部走注入的 fetch 与临时目录，不碰网络、不改仓库里的 comets.json。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  refreshDatabase, refreshIfDue, needsRefresh, readStamp, parseMpcLine, buildCometCatalog,
  databaseStatus, REFRESH_INTERVAL_MS, RETRY_COOLDOWN_MS,
} from '../lib/database.js'
import { meta } from '../lib/planner.js'

/** MPC CometEls.txt 的真实一行（22P/科普夫 2028 年回归）。 */
const SAMPLE = '0022P         2028 06 26.2465  1.319943  0.596710  166.5494  119.8957    5.2635  20261106   3.0 10.4  22P/Kopff                                                MPC191594'

function tmpFiles() {
  const dir = mkdtempSync(join(tmpdir(), 'ap-db-'))
  return { dir, dataFile: join(dir, 'comets.json'), stampFile: join(dir, 'db-stamp.json') }
}

function okResponse(text) {
  return { ok: true, status: 200, text: async () => text }
}

test('MPC 行解析：编号 / 轨道根数 / H·G / 中文名', () => {
  const c = parseMpcLine(SAMPLE)
  assert.ok(c, '应能解析 MPC 固定宽度行')
  assert.equal(c.id, '22P')
  assert.equal(c.name, '22P/科普夫彗星')
  assert.ok(Math.abs(c.q - 1.319943) < 1e-6)
  assert.ok(Math.abs(c.e - 0.59671) < 1e-6)
  assert.equal(c.H, 3)
  assert.equal(c.G, 10.4)
  assert.ok(c.tp > 2460000, `近日点 JD 应落在 2028 年前后，实际 ${c.tp}`)
  assert.equal(parseMpcLine('garbage'), null)
})

test('彗星库构建：带 updatedAt / fetched / count', async () => {
  const now = new Date('2026-11-07T14:20:00.000Z')
  const catalog = await buildCometCatalog(SAMPLE, { now })
  assert.equal(catalog.updatedAt, '2026-11-07T14:20:00.000Z')
  assert.equal(catalog.fetched, '2026-11-07')
  assert.ok(catalog.count >= 1)
  assert.equal(catalog.comets.length, catalog.count)
  assert.ok(Number.isFinite(catalog.comets[0].minMag), '应算出区间内最亮视星等')
  assert.equal(catalog.comets[0].id, '22P')
  // 全部丢掉的文本要报错，而不是写一个空库
  await assert.rejects(() => buildCometCatalog('<html>maintenance</html>', { now }), /无法解析/)
})

test('周更判断：7 天一次，失败后冷却 6 小时再重试', () => {
  const now = Date.UTC(2026, 10, 7, 12)
  const day = 86400000
  assert.equal(needsRefresh({}, now), true, '从未更新过 → 立即更新')
  assert.equal(needsRefresh({ lastSuccessAt: now - 1 * day }, now), false, '1 天前更新过 → 不动')
  assert.equal(needsRefresh({ lastSuccessAt: now - 6.9 * day }, now), false, '不到 7 天 → 不动')
  assert.equal(needsRefresh({ lastSuccessAt: now - 8 * day, lastAttemptAt: now - 8 * day }, now), true, '超过 7 天 → 更新')
  assert.equal(needsRefresh({ lastSuccessAt: now - 8 * day, lastAttemptAt: now - 3600000 }, now), false,
    '刚失败过（1 小时前）→ 等冷却，别每次启动都联网')
  assert.equal(needsRefresh({ lastSuccessAt: now - 8 * day, lastAttemptAt: now - 7 * 3600000 }, now), true,
    '冷却结束 → 再试')
  assert.equal(RETRY_COOLDOWN_MS, 6 * 3600000)
  assert.equal(REFRESH_INTERVAL_MS, 7 * 24 * 3600000)
})

test('stamp 缺失时用数据文件自带的时间兜底（装好第一次启动不重复联网）', () => {
  const { dataFile, stampFile } = tmpFiles()
  writeFileSync(dataFile, JSON.stringify({ fetched: '2026-11-07', comets: [] }))
  const stamp = readStamp(stampFile, dataFile)
  assert.equal(stamp.lastSuccessAt, Date.parse('2026-11-07'))
  assert.equal(needsRefresh(stamp, Date.parse('2026-11-07T20:00:00Z')), false)
})

test('刷新：写入新快照与 stamp，一周内再调用直接跳过', async () => {
  const { dataFile, stampFile } = tmpFiles()
  const t0 = Date.UTC(2026, 10, 7, 14, 20)
  writeFileSync(dataFile, JSON.stringify({ fetched: '2020-01-01', comets: [] }))

  const res = await refreshDatabase({ fetchImpl: async () => okResponse(SAMPLE), dataFile, stampFile, now: t0 })
  assert.equal(res.ok, true)
  assert.equal(res.skipped, false)
  assert.ok(res.count >= 1)

  const written = JSON.parse(readFileSync(dataFile, 'utf8'))
  assert.equal(written.updatedAt, new Date(t0).toISOString())
  assert.equal(written.fetched, '2026-11-07')
  assert.ok(written.comets.length >= 1)
  assert.ok(!existsSync(`${dataFile}.tmp`), '原子写不应留下 .tmp')

  const stamp = JSON.parse(readFileSync(stampFile, 'utf8'))
  assert.equal(stamp.lastSuccessAt, t0)
  assert.equal(stamp.lastAttemptAt, t0)
  assert.equal(stamp.lastError, null)

  const again = await refreshDatabase({ fetchImpl: async () => okResponse(SAMPLE), dataFile, stampFile, now: t0 + 86400000 })
  assert.equal(again.skipped, true)
  assert.equal(again.reason, 'fresh')

  const week = await refreshDatabase({ fetchImpl: async () => okResponse(SAMPLE), dataFile, stampFile, now: t0 + 8 * 86400000 })
  assert.equal(week.skipped, false, '超过一周应重新拉取')
})

test('刷新失败：保留旧快照、只记错误，不抛错', async () => {
  const { dataFile, stampFile } = tmpFiles()
  const t0 = Date.UTC(2026, 10, 7, 14, 20)
  const old = { fetched: '2020-01-01', comets: [{ id: 'X' }] }
  writeFileSync(dataFile, JSON.stringify(old))

  const res = await refreshDatabase({
    fetchImpl: async () => { throw new Error('offline') },
    dataFile, stampFile, now: t0, force: true,
  })
  assert.equal(res.ok, false)
  assert.equal(res.error, 'refresh_failed')
  assert.match(res.message, /offline/)
  assert.deepEqual(JSON.parse(readFileSync(dataFile, 'utf8')), old, '旧快照必须原样保留')
  const stamp = JSON.parse(readFileSync(stampFile, 'utf8'))
  assert.equal(stamp.lastError, 'offline')
  assert.equal(stamp.lastAttemptAt, t0)
})

test('refreshIfDue：不到点不联网，到点后台跑（不阻塞调用方）', async () => {
  const { dataFile, stampFile } = tmpFiles()
  const t0 = Date.UTC(2026, 10, 7, 14, 20)
  writeFileSync(dataFile, JSON.stringify({ fetched: '2026-11-07', comets: [] }))

  const fresh = refreshIfDue({ dataFile, stampFile, now: t0, fetchImpl: async () => okResponse(SAMPLE) })
  assert.equal(fresh.started, false, '刚更新的快照不该再联网')

  const due = refreshIfDue({
    dataFile, stampFile, now: t0 + 30 * 86400000,
    fetchImpl: async () => okResponse(SAMPLE),
  })
  assert.equal(due.started, true)
  assert.equal(typeof due.promise?.then, 'function', '应立即返回，结果由 promise 回调')
  const done = await due.promise
  assert.equal(done.ok, true)
  assert.equal(done.skipped, false)
})

test('meta 暴露数据库更新时间（页面第一行小字直读）', () => {
  const m = meta()
  assert.match(m.database.updatedAtText, /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/)
  assert.equal(m.database.refreshDays, 7)
  assert.equal(m.database.cometCount, m.comets.count)
  assert.equal(m.database.siteCount, m.stats.total)
  assert.ok(m.database.source.includes('Minor Planet Center'))
  const status = databaseStatus()
  assert.equal(status.cometCount, m.comets.count)
})
