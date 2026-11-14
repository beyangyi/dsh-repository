import test from 'node:test'
import assert from 'node:assert/strict'

import { deletionEntries, prunePaths } from '../tools/prune-diff.mjs'

test('prune：远端有、本地没有的路径才删除', () => {
  const local = ['lib/a.js', 'docs/user-guide.md', 'README.md']
  const remote = ['lib/a.js', 'lib/old.js', 'docs/wechat/guide.html', 'docs/user-guide.md', 'README.md']
  assert.deepEqual(prunePaths(local, remote), ['docs/wechat/guide.html', 'lib/old.js'])
})

test('prune：仓库管理文件受保护，不会被删', () => {
  const local = ['lib/a.js']
  const remote = ['lib/a.js', '.github/workflows/x.yml', '.gitignore', 'LICENSE', 'README.md', 'docs/wechat/guide.html']
  assert.deepEqual(prunePaths(local, remote), ['docs/wechat/guide.html'])
})

test('prune：--exclude 的路径不参与删除', () => {
  const local = ['lib/a.js']
  const remote = ['lib/a.js', 'tests/fixtures/big.json', 'docs/old.md']
  assert.deepEqual(prunePaths(local, remote, { exclude: ['tests/fixtures'] }), ['docs/old.md'])
})

test('prune：删除条目是 GitHub Trees 的 sha: null 形式', () => {
  const entries = deletionEntries(['docs/wechat/guide.html'])
  assert.deepEqual(entries, [{ path: 'docs/wechat/guide.html', mode: '100644', type: 'blob', sha: null }])
})

test('prune：本地与远端一致时不产生删除', () => {
  const same = ['lib/a.js', 'README.md']
  assert.deepEqual(prunePaths(same, same), [])
})
