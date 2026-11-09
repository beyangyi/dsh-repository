/**
 * dsh-astro-plan — 数据库维护。
 *
 * 插件内置两类数据：
 *   ① 站点库 / 目标库 / 事件表（lib/data/sites-*.json、targets.json、events.json）
 *      随版本发布，不联网，升级插件即更新；
 *   ② 彗星库（lib/data/comets.json）来自 MPC CometEls.txt，跟新发现与新观测强相关，
 *      因此每周首次启动时在后台重建一次。
 *
 * 约束：
 *   - 启动不等网络：周更在后台跑，失败保留旧快照，页面照常可用；
 *   - 失败后 6 小时内不再重试，离线时不会每次启动都打网络；
 *   - 成功写入后热替换内存里的彗星表（comets.reloadComets），不必重启应用；
 *   - 目录只读（例如插件装在 node_modules）时只记日志，不抛错。
 */

import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { COMET_META, COMETS, cometState, reloadComets } from './comets.js'

const HERE = dirname(fileURLToPath(import.meta.url))

export const DATA_DIR = join(HERE, 'data')
export const COMET_FILE = join(DATA_DIR, 'comets.json')
export const STAMP_FILE = join(DATA_DIR, 'db-stamp.json')

/** MPC 彗星轨道与 H/G 亮度参数（固定宽度文本）。 */
export const MPC_URL = 'https://www.minorplanetcenter.net/iau/MPCORB/CometEls.txt'

/** 周更节奏：7 天；失败重试冷却 6 小时。 */
export const REFRESH_INTERVAL_MS = 7 * 24 * 3600 * 1000
export const RETRY_COOLDOWN_MS = 6 * 3600 * 1000

/** 彗星中文名（其余用国际编号） */
const CN = {
  '1P': '哈雷彗星',
  '2P': '恩克彗星',
  '7P': '庞斯-温内克彗星',
  '8P': '塔特尔彗星',
  '9P': '坦普尔1号彗星',
  '12P': '庞斯-布鲁克斯彗星',
  '13P': '奥伯斯彗星',
  '14P': '沃尔夫彗星',
  '15P': '芬利彗星',
  '17P': '霍姆斯彗星',
  '19P': '博雷利彗星',
  '21P': '贾可比尼-津纳彗星',
  '22P': '科普夫彗星',
  '23P': '布罗森-梅特卡夫彗星',
  '24P': '肖马斯彗星',
  '26P': '格里格-斯克耶勒鲁普彗星',
  '27P': '克罗姆林彗星',
  '29P': '施瓦斯曼-瓦赫曼1号彗星',
  '38P': '斯特凡-奥尔特玛彗星',
  '43P': '沃尔夫-哈林顿彗星',
  '45P': '本田-姆尔科斯-帕伊杜沙科娃彗星',
  '46P': '维尔塔宁彗星',
  '48P': '约翰逊彗星',
  '53P': '范比斯布鲁克彗星',
  '55P': '坦普尔-塔特尔彗星',
  '57P': '杜托伊特-诺伊明彗星',
  '62P': '紫金山1号彗星',
  '64P': '斯威夫特-盖勒斯彗星',
  '67P': '丘留莫夫-格拉西缅科彗星',
  '71P': '克拉克彗星',
  '73P': '施瓦斯曼-瓦赫曼3号彗星',
  '84P': '吉克尔彗星',
  '88P': '豪厄尔彗星',
  '96P': '梅克赫兹彗星',
  '103P': '哈特雷2号彗星',
  '108P': '西费罗彗星',
  '109P': '斯威夫特-塔特尔彗星',
  '113P': '斯皮塔莱里彗星',
  '117P': '海琳-罗曼-阿尔科克彗星',
  '118P': '肖梅克-利维4号彗星',
  '128P': '肖梅克-霍尔特彗星',
  '139P': '维尔塔宁-奥托马彗星',
  '144P': '串田彗星',
  '153P': '池谷-张彗星',
  '162P': '赛丁泉2号彗星',
  '168P': '海琳-罗曼-阿尔科克彗星',
  '188P': '利尼爾彗星',
  '206P': '巴纳德-博阿蒂尼彗星',
  '209P': '林尼尔彗星',
  '219P': '林尼尔彗星',
  '249P': '林尼尔彗星',
  '255P': '莱维彗星',
  '260P': '麦克诺特彗星',
  '268P': '伯纳德-伯恩斯坦彗星',
  '289P': '布兰帕因彗星',
  '322P': 'SOHO彗星',
  '331P': '吉布斯彗星',
}

/** "2024 09 27.8408" → JD（与 MPC 同为力学时，秒级差异可忽略）。 */
function dateToJd(y, m, d) {
  return (Date.UTC(y, m - 1, 1) + (d - 1) * 86400000) / 86400000 + 2440587.5
}

/**
 * MPC CometEls.txt 固定宽度行：
 *   1-12 编号/暂定编号 | 13-18 近日点年 | 19-20 月 | 21-29 日
 *   30-39 近日距 q | 40-49 偏心率 e | 50-59 近日点幅角 | 60-69 升交点黄经
 *   70-79 倾角 | 80-87 历元 | 88-95 H | 96-103 G | 104- 名称
 * 用正则抓「年 月 日」这一组，避免手工数字符位。
 */
const LINE = /^\s*(\S{1,12}?)\s+(\d{4})\s+(\d{2})\s+(\d{2}\.\d{4,})\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(\d{8})\s+(-?\d+\.\d)\s+(-?\d+\.\d)\s+(.+?)\s{2,}/

/** MPC 行 → 目标对象（解析失败返回 null）。 */
export function parseMpcLine(line) {
  const m = LINE.exec(line)
  if (!m) return null
  const [, packed, y, mo, d, q, e, w, om, inc, epoch, H, G, name] = m
  const comet = {
    e: Number(e), q: Number(q), i: Number(inc), om: Number(om), w: Number(w),
    tp: dateToJd(Number(y), Number(mo), Number(d)),
    H: Number(H), G: Number(G),
  }
  if (!Object.values(comet).every(Number.isFinite)) return null
  // 近日距过大看不到、过小是掠日彗星（永远贴着太阳）
  if (!(comet.q > 0.05 && comet.q < 6)) return null
  const designation = name.trim()
  // D/ 与 nD/ 是「已消失 / 已分裂」的彗星，轨道根数只对历史观测有意义
  if (/^(\d+)?D\//.test(designation)) return null
  if (/^[A-Z]{1,2}\dD/.test(packed)) return null

  const numMatch = /^(\d+)P\//.exec(designation)
  const cn = numMatch ? CN[`${numMatch[1]}P`] : null
  return {
    ...comet,
    id: (numMatch ? `${numMatch[1]}P` : packed.trim()).replace(/[^0-9A-Za-z-]/g, ''),
    designation,
    name: cn ? `${numMatch[1]}P/${cn}` : designation,
    epoch: String(epoch),
  }
}

/**
 * MPC 文本 → comets.json 结构。
 *
 * 窗口 2024–2045、亮度门槛 15 等：把「相机/望远镜能拍」的彗星都收进来，
 * 查询时再按视星等 ≤ 9、距日 ≥ 10° 严格过滤（统计口径与检索口径分开）。
 * 每处理 yieldEvery 颗让出一次事件循环，周更时不会卡住 HTTP 服务。
 */
export async function buildCometCatalog(text, options = {}) {
  const {
    now = new Date(),
    from = Date.UTC(2024, 0, 1),
    to = Date.UTC(2045, 0, 1),
    stepDays = 5,
    maxMag = 15,
    yieldEvery = 25,
    log = () => {},
  } = options

  const rows = String(text).split('\n').map(parseMpcLine).filter(Boolean)
  log(`MPC 彗星轨道 ${rows.length} 条`)
  if (rows.length === 0) throw new Error('MPC 返回内容无法解析（可能是站点维护页）')

  const stepMs = stepDays * 86400000
  const keep = []
  for (let i = 0; i < rows.length; i += 1) {
    const comet = rows[i]
    let best = { mag: 99, at: null }
    for (let t = from; t <= to; t += stepMs) {
      let st
      try { st = cometState(comet, new Date(t)) } catch { st = null }
      if (!st || !Number.isFinite(st.mag)) continue
      if (st.mag < best.mag) best = { mag: st.mag, at: new Date(t).toISOString().slice(0, 10) }
    }
    if (best.mag <= maxMag) {
      keep.push({ ...comet, minMag: Math.round(best.mag * 10) / 10, minMagAt: best.at })
    }
    if (yieldEvery > 0 && i % yieldEvery === yieldEvery - 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  keep.sort((x, y) => x.minMag - y.minMag)
  const seen = new Set()
  const uniq = []
  for (const c of keep) {
    if (seen.has(c.id)) continue
    seen.add(c.id)
    uniq.push(c)
  }

  const at = now instanceof Date ? now : new Date(now)
  return {
    source: 'Minor Planet Center · CometEls.txt（彗星轨道与 H/G 亮度参数）',
    url: MPC_URL,
    // fetched 只到日期（旧字段，兼容历史数据）；updatedAt 精确到秒，页面显示用这个
    fetched: at.toISOString().slice(0, 10),
    updatedAt: at.toISOString(),
    method: '二体开普勒传播（椭圆/抛物/双曲）+ 亮度模型 m = H + 5·log10(Δ) + 2.5·G·log10(r)，'
      + '未计行星摄动与非引力加速度，日期越远误差越大；月相/高度/天气由规划器另行计算',
    window: '2024-01-01 ~ 2044-12-31',
    threshold: '区间内最亮 ≤ 15 等（查询时再按视星等 ≤ 9、距日 ≥ 10° 严格过滤）',
    count: uniq.length,
    comets: uniq,
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 原子写：先写 .tmp 再改名，避免写到一半被读到。 */
function writeJson(file, value) {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`)
  renameSync(tmp, file)
}

export function readStamp(file = STAMP_FILE, dataFile = COMET_FILE) {
  const stamp = readJson(file)
  if (stamp && Number(stamp.lastSuccessAt)) return stamp
  // 还没写过 stamp（刚安装 / 刚升级）：用数据文件自带的时间兜底，
  // 免得装好第一次启动就为了「其实刚生成的快照」去联网。
  const catalog = readJson(dataFile)
  const iso = catalog?.updatedAt ?? catalog?.fetched
  const ms = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(ms)) return stamp && typeof stamp === 'object' ? stamp : {}
  return { lastSuccessAt: ms, lastAttemptAt: ms, ...(stamp ?? {}) }
}

/**
 * 是否到了周更时间。
 *  - 从未成功、也没尝试过 → 该更新；
 *  - 距上次成功 ≥ 7 天 → 该更新，但失败过要等 6 小时冷却；
 *  - 上次成功在 7 天内 → 不动。
 */
export function needsRefresh(stamp, now = Date.now(), options = {}) {
  const intervalMs = options.intervalMs ?? REFRESH_INTERVAL_MS
  const retryMs = options.retryMs ?? RETRY_COOLDOWN_MS
  const lastOk = Number(stamp?.lastSuccessAt) || 0
  const lastTry = Number(stamp?.lastAttemptAt) || 0
  if (!lastOk && !lastTry) return true
  if (lastOk && now - lastOk < intervalMs) return false
  if (!lastOk) return true
  // 上次成功已过一周：成功过就先试一次；失败过则等冷却结束
  if (!lastTry) return true
  return now - lastTry >= retryMs
}

/** 运行时状态（仅本进程内，重启后以 stamp 为准）。 */
const runtime = { running: false, lastAttemptAt: null, lastError: null, lastResult: null }

/** 页面/工具用：数据库更新时间与状态。 */
export function databaseStatus() {
  const stamp = readStamp()
  const updatedAt = COMET_META.updatedAt ?? COMET_META.fetched ?? null
  return {
    updatedAt,
    version: stamp.version ?? null,
    cometCount: COMETS.length,
    source: COMET_META.source,
    url: COMET_META.url,
    running: runtime.running,
    lastAttemptAt: runtime.lastAttemptAt ?? stamp.lastAttemptAt ?? null,
    lastSuccessAt: stamp.lastSuccessAt ?? null,
    lastError: runtime.lastError ?? stamp.lastError ?? null,
    refreshDays: Math.round(REFRESH_INTERVAL_MS / 86400000),
  }
}

/**
 * 重建彗星库（默认走网络）。已注入 fetchNow / dataFile / stampFile，便于测试。
 * 返回 { ok, skipped, count, updatedAt, message }，不抛错。
 */
export async function refreshDatabase(options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    force = false,
    now = Date.now(),
    dataFile = COMET_FILE,
    stampFile = STAMP_FILE,
    url = MPC_URL,
    timeoutMs = 20000,
    log = () => {},
  } = options

  const stamp = readStamp(stampFile, dataFile)
  if (!force && !needsRefresh(stamp, now)) {
    return { ok: true, skipped: true, reason: 'fresh', count: COMETS.length, stamp }
  }
  if (runtime.running) return { ok: true, skipped: true, reason: 'busy', count: COMETS.length, stamp }

  runtime.running = true
  runtime.lastAttemptAt = now
  try {
    if (typeof fetchImpl !== 'function') throw new Error('当前环境没有 fetch')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res
    try {
      res = await fetchImpl(url, { signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
    if (!res || !res.ok) throw new Error(`MPC 返回 ${res?.status ?? '无响应'}`)
    const text = await res.text()
    const catalog = await buildCometCatalog(text, { now: new Date(now), log })
    writeJson(dataFile, catalog)
    writeJson(stampFile, {
      lastAttemptAt: now,
      lastSuccessAt: now,
      lastError: null,
      source: url,
      comets: catalog.count,
    })
    runtime.lastError = null
    runtime.lastResult = { count: catalog.count, updatedAt: catalog.updatedAt }
    // 热替换：本进程立刻用上新彗星表，不必重启应用
    if (dataFile === COMET_FILE) reloadComets()
    return { ok: true, skipped: false, count: catalog.count, updatedAt: catalog.updatedAt }
  } catch (error) {
    const message = String(error?.message ?? error)
    runtime.lastError = message
    try {
      writeJson(stampFile, { ...stamp, lastAttemptAt: now, lastError: message })
    } catch {
      // 插件目录只读：只留内存状态
    }
    return { ok: false, skipped: false, error: 'refresh_failed', message }
  } finally {
    runtime.running = false
  }
}

/**
 * 启动钩子：到点了才在后台跑，绝不阻塞插件加载、也绝不把异常抛给宿主。
 */
export function refreshIfDue(options = {}) {
  const now = options.now ?? Date.now()
  const stamp = readStamp(options.stampFile ?? STAMP_FILE, options.dataFile ?? COMET_FILE)
  const force = options.force === true
  if (!force && !needsRefresh(stamp, now)) {
    return { started: false, reason: 'fresh', stamp }
  }
  const promise = refreshDatabase({ ...options, now, force })
  promise.catch(() => {})
  return { started: true, reason: force ? 'forced' : 'due', promise }
}
