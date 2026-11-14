/**
 * 远端删除差集：远端有、本地没有的路径（供 push-repo 的 --prune 使用）。
 * 纯函数，方便单测。
 */

/** 默认保护：仓库管理文件不参与删除。 */
export const DEFAULT_PROTECT = [/^\.github\//u, /^\.gitignore$/u, /^LICENSE/u, /^README\.md$/u]

/**
 * @param {string[]} localPaths 本次将要推送的本地路径
 * @param {string[]} remotePaths 远端当前存在的 blob 路径
 * @param {{protect?: RegExp[], exclude?: string[]}} options
 * @returns {string[]} 需要删除、且已排序的路径
 */
export function prunePaths(localPaths, remotePaths, options = {}) {
  const protect = options.protect ?? DEFAULT_PROTECT
  const excludes = options.exclude ?? []
  const local = new Set(localPaths)
  return remotePaths
    .filter((path) => !local.has(path))
    .filter((path) => !protect.some((rule) => rule.test(path)))
    .filter((path) => !excludes.some((prefix) => prefix && path.startsWith(prefix)))
    .sort()
}

/** 生成 GitHub Trees API 的删除条目（sha: null）。 */
export function deletionEntries(paths) {
  return paths.map((path) => ({ path, mode: '100644', type: 'blob', sha: null }))
}
