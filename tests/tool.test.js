import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, name, inject } from '../lib/index.js'

function fakeCtx() {
  const tools = []
  return {
    tools,
    effect(fn) { fn(); return () => {} },
    inject() {},
    toolsRegister(tool) { tools.push(tool) },
  }
}

test('宿主插件导出契约', () => {
  assert.equal(name, 'dsh-astro-plan')
  assert.deepEqual(inject, ['tools'])
  assert.equal(typeof apply, 'function')
})

test('apply 注册 astro_plan 工具', () => {
  const ctx = {
    effect(fn) { fn(); return () => {} },
    inject() {},
    tools: { register(tool) { ctx.registered = tool; return () => {} } },
  }
  apply(ctx)
  assert.ok(ctx.registered, '工具应被注册')
  assert.equal(ctx.registered.name, 'astro_plan')
  assert.equal(ctx.registered.parameters.properties.action.enum.includes('search'), true)
})

test('工具 execute: meta 返回数据概览', async () => {
  const ctx = {
    effect(fn) { fn(); return () => {} },
    inject() {},
    tools: { register(tool) { ctx.registered = tool; return () => {} } },
  }
  apply(ctx)
  const out = await ctx.registered.execute({ action: 'meta' })
  assert.equal(out.ok, true)
  assert.match(out.markdown, /站点 \d+ 个/)
  assert.ok(out.meta.stats.total >= 90)
})

test('工具 execute: params 返回焦段与要点', async () => {
  const ctx = {
    effect(fn) { fn(); return () => {} },
    inject() {},
    tools: { register(tool) { ctx.registered = tool; return () => {} } },
  }
  apply(ctx)
  const out = await ctx.registered.execute({ action: 'params', targetId: 'm42' })
  assert.equal(out.ok, true)
  assert.match(out.markdown, /135–200mm/)
})

test('工具 execute: events 列出流星雨', async () => {
  const ctx = {
    effect(fn) { fn(); return () => {} },
    inject() {},
    tools: { register(tool) { ctx.registered = tool; return () => {} } },
  }
  apply(ctx)
  const out = await ctx.registered.execute({ action: 'events', dateStart: '2026-11-01', dateEnd: '2026-11-30' })
  assert.equal(out.ok, true)
  assert.match(out.markdown, /金牛座北流星雨/)
})

test('工具 execute: window 返回时间轴 markdown', async () => {
  const ctx = {
    effect(fn) { fn(); return () => {} },
    inject() {},
    tools: { register(tool) { ctx.registered = tool; return () => {} } },
  }
  apply(ctx)
  const out = await ctx.registered.execute({ action: 'window', location: 'haituo', dateStart: '2026-11-13' })
  assert.equal(out.ok, true)
  assert.match(out.markdown, /海坨山/)
  assert.match(out.markdown, /18:35/)
})

test('工具 output.render 输出 markdown 文本', () => {
  const ctx = {
    effect(fn) { fn(); return () => {} },
    inject() {},
    tools: { register(tool) { ctx.registered = tool; return () => {} } },
  }
  apply(ctx)
  const rendered = ctx.registered.output.render({}, { ok: true, markdown: '# 示例' })
  assert.deepEqual(rendered, [{ type: 'text', text: '# 示例' }])
})
