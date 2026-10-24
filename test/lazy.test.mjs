import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyLazyBridge, DEFAULT_BOOTSTRAP, bootstrapDescription, sameSession } from '../lib/lazy.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FAKE = join(ROOT, 'test', 'fixtures', 'fake-mcp.mjs')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fakeAgentCtx() {
  const registered = []
  const restricts = []
  return {
    registered,
    restricts,
    tools: {
      register(def) { registered.push(def); return () => { def.__disposed = true } },
      restrict(options) { restricts.push(options); return () => { restricts.push('lifted') } },
    },
  }
}

function fakeCtx() {
  const registered = []
  const listeners = new Map()
  const effects = []
  return {
    registered,
    tools: { register(def) { registered.push(def); return () => { def.__disposed = true } } },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
      return () => {
        const list = listeners.get(event)
        const i = list.indexOf(fn)
        if (i >= 0) list.splice(i, 1)
      }
    },
    emit(event, ...args) {
      for (const fn of listeners.get(event) ?? []) fn(...args)
    },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') effects.push(dispose) },
    runEffects() { for (const dispose of effects.splice(0)) dispose() },
  }
}

const OPTS = { command: `node "${FAKE}"`, prefix: 'edge', env: {}, timeoutMs: 10000 }

test('lazy bridge exposes one bootstrap tool and activates the real tools per Agent', async () => {
  const ctx = fakeCtx()
  const res = await applyLazyBridge(ctx, (d) => d, OPTS)
  assert.equal(res.mode, 'lazy')
  assert.deepEqual(res.tools.sort(), ['edge_close', 'edge_fill_form', 'edge_navigate', 'edge_snapshot', 'edge_take_screenshot'])
  assert.equal(ctx.registered.length, 1, 'only the bootstrap is registered at boot')
  const bootstrap = ctx.registered[0]
  assert.equal(bootstrap.name, DEFAULT_BOOTSTRAP)
  assert.match(bootstrap.description, /NOT loaded by default/)
  assert.match(bootstrap.description, /edge_navigate/)

  const agent = { ctx: fakeAgentCtx() }
  const first = await bootstrap.execute({}, { agent })
  assert.equal(first.activated, true)
  assert.deepEqual(first.tools.sort(), res.tools.sort())
  assert.equal(agent.ctx.registered.length, 5, 'real tools registered for this agent')
  assert.deepEqual(agent.ctx.restricts[0], { deny: [DEFAULT_BOOTSTRAP] })

  const again = await bootstrap.execute({}, { agent })
  assert.equal(again.activated, false)
  assert.equal(agent.ctx.registered.length, 5, 'idempotent: no duplicate registration')

  const nav = agent.ctx.registered.find((d) => d.name === 'edge_navigate')
  const out = await nav.execute({ url: 'https://example.com' })
  assert.equal(out.ok, true)
  assert.match(out.text, /navigated to https:\/\/example\.com/)

  const other = { ctx: fakeAgentCtx() }
  const otherOut = await bootstrap.execute({}, { agent: other })
  assert.equal(otherOut.activated, true, 'scope is per Agent')
  assert.equal(other.ctx.registered.length, 5)

  ctx.emit('agent/disposed', { agent })
  assert.ok(agent.ctx.registered.every((d) => d.__disposed), 'agent disposal removes its tools')
  assert.equal(other.ctx.registered.every((d) => d.__disposed), false, 'sibling untouched')
  ctx.runEffects()
})

test('lazy bridge rejects activation without an Agent', async () => {
  const ctx = fakeCtx()
  await applyLazyBridge(ctx, (d) => d, OPTS)
  await assert.rejects(() => ctx.registered[0].execute({}, {}), /Agent Session is required/)
  ctx.runEffects()
})

test('lazy bridge is inert when the server cannot start', async () => {
  const ctx = fakeCtx()
  const res = await applyLazyBridge(ctx, (d) => d, {
    command: 'definitely-not-a-real-mcp-binary-xyz',
    prefix: 'edge', env: {}, timeoutMs: 300, initTimeoutMs: 600,
  })
  assert.deepEqual(res.registered, [])
  assert.equal(ctx.registered.length, 0)
  assert.match(String(res.error), /./)
})

test('bootstrapDescription is compact and names the tools', () => {
  const text = bootstrapDescription(['edge_navigate', 'edge_click'])
  assert.match(text, /edge_navigate, edge_click/)
  assert.match(text, /NOT loaded by default/)
  assert.ok(text.length < 700, 'description stays small: ' + text.length)
})

test('bootstrapDescription explains the auto-unload only when it is enabled', () => {
  assert.doesNotMatch(bootstrapDescription(['edge_click']), /unload/i)
  const idle = bootstrapDescription(['edge_click'], { releaseMs: 180000 })
  assert.match(idle, /unload again after 180s/)
  const turnEnd = bootstrapDescription(['edge_click'], { releaseMs: 0, releaseOnTurnEnd: true })
  assert.match(turnEnd, /when the turn ends/)
  const both = bootstrapDescription(['edge_click'], { releaseMs: 180000, releaseOnTurnEnd: true })
  assert.match(both, /when the turn ends \(or after 180s idle\)/)
})

test('the browser tools unload as soon as the browsing turn ends', async () => {
  const ctx = fakeCtx()
  const res = await applyLazyBridge(ctx, (d) => d, { ...OPTS, releaseMs: 0 })
  assert.equal(res.releaseOnTurnEnd, true)
  const bootstrap = ctx.registered[0]
  const session = { header: { id: 'sess-a' }, id: 'sess-a' }
  const agent = { ctx: fakeAgentCtx(), session }

  await bootstrap.execute({}, { agent })
  assert.equal(agent.ctx.registered.length, 5)

  // Another session's turn must not touch this Agent.
  ctx.emit('session/event', { header: { id: 'sess-b' } }, { type: 'turn/end', seq: 1 })
  assert.equal(agent.ctx.registered.every((d) => d.__disposed), false, 'other session ignored')

  ctx.emit('session/event', session, { type: 'turn/end', seq: 2 })
  assert.ok(agent.ctx.registered.every((d) => d.__disposed), 'turn end unloads the tools')
  assert.equal(agent.ctx.restricts.at(-1), 'lifted', 'the bootstrap entry is visible again')

  const again = await bootstrap.execute({}, { agent })
  assert.equal(again.activated, true, 'the next turn can reload with one call')
  ctx.runEffects()
})

test('turn-end release can be turned off (idle backstop only)', async () => {
  const ctx = fakeCtx()
  const res = await applyLazyBridge(ctx, (d) => d, { ...OPTS, releaseOnTurnEnd: false, releaseMs: 0 })
  assert.equal(res.releaseOnTurnEnd, false)
  const session = { header: { id: 'sess-c' } }
  const agent = { ctx: fakeAgentCtx(), session }
  await ctx.registered[0].execute({}, { agent })
  ctx.emit('session/event', session, { type: 'turn/end' })
  assert.equal(agent.ctx.registered.every((d) => d.__disposed), false, 'no turn-end release')
  ctx.runEffects()
})

test('sameSession matches by identity or by id', () => {
  assert.equal(sameSession({ id: 'x' }, { id: 'x' }), true)
  assert.equal(sameSession({ id: 'x' }, { header: { id: 'x' } }), true)
  assert.equal(sameSession({ header: { id: 'x' } }, { header: { id: 'y' } }), false)
  assert.equal(sameSession(undefined, undefined), true)
  assert.equal(sameSession(undefined, { id: 'x' }), false)
})

test('the browser tools unload after an idle period and the bootstrap returns', async () => {
  const ctx = fakeCtx()
  const res = await applyLazyBridge(ctx, (d) => d, { ...OPTS, releaseMs: 100 })
  assert.equal(res.releaseMs, 100)
  const bootstrap = ctx.registered[0]
  const agent = { ctx: fakeAgentCtx() }

  await bootstrap.execute({}, { agent })
  assert.equal(agent.ctx.registered.length, 5)
  assert.deepEqual(agent.ctx.restricts[0], { deny: [DEFAULT_BOOTSTRAP] })

  await delay(260)
  assert.ok(agent.ctx.registered.every((d) => d.__disposed), 'idle release disposes every tool')
  assert.equal(agent.ctx.restricts.at(-1), 'lifted', 'the bootstrap entry is visible again')

  const again = await bootstrap.execute({}, { agent })
  assert.equal(again.activated, true, 'it can be loaded again on demand')
  assert.equal(agent.ctx.registered.length, 10, 'reloading registers a fresh tool set')
  ctx.runEffects()
})

test('a browser call resets the idle countdown', async () => {
  const ctx = fakeCtx()
  await applyLazyBridge(ctx, (d) => d, { ...OPTS, releaseMs: 240 })
  const bootstrap = ctx.registered[0]
  const agent = { ctx: fakeAgentCtx() }
  await bootstrap.execute({}, { agent })
  const nav = agent.ctx.registered.find((d) => d.name === 'edge_navigate')

  await delay(160)
  await nav.execute({ url: 'https://example.com' })
  await delay(160) // 320ms after activation, but only 160ms after the call
  assert.equal(
    agent.ctx.registered.every((d) => d.__disposed),
    false,
    'still loaded: the call refreshed the countdown',
  )

  await delay(240) // well past the window measured from the last call
  assert.ok(agent.ctx.registered.every((d) => d.__disposed), 'released once the idle window passes')
  ctx.runEffects()
})

test('edge_close unloads the browser tools right away', async () => {
  const ctx = fakeCtx()
  await applyLazyBridge(ctx, (d) => d, { ...OPTS, releaseMs: 600000 })
  const bootstrap = ctx.registered[0]
  const agent = { ctx: fakeAgentCtx() }
  await bootstrap.execute({}, { agent })
  const close = agent.ctx.registered.find((d) => d.name === 'edge_close')
  assert.ok(close, 'the close tool is part of the default set')

  const out = await close.execute({})
  assert.equal(out.ok, true)
  await delay(20) // the release is deferred one tick so the close result still returns
  assert.ok(agent.ctx.registered.every((d) => d.__disposed), 'close releases immediately, not after 10 min')
  assert.equal(agent.ctx.restricts.at(-1), 'lifted')
  ctx.runEffects()
})

test('release can be disabled entirely', async () => {
  const ctx = fakeCtx()
  const res = await applyLazyBridge(ctx, (d) => d, { ...OPTS, releaseMs: 0, releaseOnTurnEnd: false })
  assert.equal(res.releaseMs, 0)
  assert.equal(res.releaseOnTurnEnd, false)
  const bootstrap = ctx.registered[0]
  const session = { header: { id: 'sess-d' } }
  const agent = { ctx: fakeAgentCtx(), session }
  await bootstrap.execute({}, { agent })
  ctx.emit('session/event', session, { type: 'turn/end' })
  await delay(150)
  assert.equal(agent.ctx.registered.every((d) => d.__disposed), false, 'tools stay loaded')
  assert.ok(!agent.ctx.restricts.includes('lifted'), 'the bootstrap stays hidden')
  ctx.runEffects()
})
