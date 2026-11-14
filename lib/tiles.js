/**
 * Open-Meteo / Esri 瓦片代理：地图只保留**地形**底图（World_Topo_Map，失败退 World_Terrain_Base）。
 *
 * - /astro-plan/api/tile/topo/{z}/{x}/{y}
 * - 缓存：<tmp>/dsh-astro-tiles/<style>/<z>/<x>/<y>.<ext>，7 天；内存 LRU 200 张
 * - 只允许 Esri 主机，避免成为开放代理
 */

import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const HOSTS = ['server.arcgisonline.com']
const SERVICES = {
  topo: ['World_Topo_Map', 'World_Terrain_Base'],
}
const CACHE_DIR = join(tmpdir(), 'dsh-astro-tiles')
const TTL_MS = 7 * 86400 * 1000
const MEMORY_MAX = 200
const memory = new Map() // key -> { at, body, type, source }
let inflight = 0
const MAX_INFLIGHT = 6

export const TILE_STYLES = Object.keys(SERVICES)

function upstreamUrl(service, z, x, y) {
  return `https://server.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/${z}/${y}/${x}`
}

function validate(style, z, x, y) {
  if (!SERVICES[style]) return '只支持地形底图（style=topo）'
  if (!Number.isInteger(z) || z < 3 || z > 17) return 'z 必须在 3–17'
  const max = 2 ** z
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= max || y >= max) return 'x/y 超出该缩放级范围'
  return null
}

function cachePath(style, z, x, y) {
  return join(CACHE_DIR, style, String(z), String(x), `${y}.img`)
}

function readCache(style, z, x, y) {
  const file = cachePath(style, z, x, y)
  try {
    if (!existsSync(file)) return null
    if (Date.now() - statSync(file).mtimeMs > TTL_MS) return null
    return readFileSync(file)
  } catch {
    return null
  }
}

function writeCache(style, z, x, y, body) {
  try {
    const file = cachePath(style, z, x, y)
    mkdirSync(join(CACHE_DIR, style, String(z), String(x)), { recursive: true })
    writeFileSync(file, body)
  } catch {
    /* 缓存失败不影响返回 */
  }
}

async function fetchUpstream(style, z, x, y) {
  let lastError = null
  for (const service of SERVICES[style]) {
    const url = upstreamUrl(service, z, x, y)
    if (!HOSTS.includes(new URL(url).hostname)) throw new Error('非白名单主机')
    if (inflight >= MAX_INFLIGHT) await new Promise((resolve) => setTimeout(resolve, 60))
    inflight += 1
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 6000)
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'dsh-astro-plan/0.2.1 (+https://github.com/SiriusYANG91/dsh-astro-plan)' }, signal: controller.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = Buffer.from(await res.arrayBuffer())
      return { body, type: res.headers.get('content-type') || 'image/jpeg', source: service }
    } catch (error) {
      lastError = error
    } finally {
      clearTimeout(timer)
      inflight -= 1
    }
  }
  throw lastError ?? new Error('tile upstream failed')
}

/**
 * 取一张瓦片。
 * @returns {Promise<{status:number, body?:Buffer, type?:string, source?:string, error?:string}>}
 */
export async function getTile(style, z, x, y) {
  const bad = validate(style, z, x, y)
  if (bad) return { status: 400, error: bad }
  const key = `${style}/${z}/${x}/${y}`
  const mem = memory.get(key)
  if (mem && Date.now() - mem.at < TTL_MS) return { status: 200, body: mem.body, type: mem.type, source: mem.source }
  const disk = readCache(style, z, x, y)
  if (disk) {
    memory.set(key, { at: Date.now(), body: disk, type: 'image/jpeg', source: 'cache' })
    return { status: 200, body: disk, type: 'image/jpeg', source: 'disk' }
  }
  try {
    const { body, type, source } = await fetchUpstream(style, z, x, y)
    writeCache(style, z, x, y, body)
    if (memory.size >= MEMORY_MAX) memory.delete(memory.keys().next().value)
    memory.set(key, { at: Date.now(), body, type, source })
    return { status: 200, body, type, source }
  } catch (error) {
    return { status: 502, error: String(error?.message ?? error) }
  }
}

/** 清空内存缓存（测试用）。 */
export function resetTileMemory() {
  memory.clear()
}
