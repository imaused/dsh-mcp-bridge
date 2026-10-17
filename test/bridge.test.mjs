import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyBridge, createMcpClient, normalizeResult, splitCommand } from '../lib/bridge.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FAKE = join(ROOT, 'test', 'fixtures', 'fake-mcp.mjs')

function fakeCtx() {
  const registered = []
  const disposers = []
  return {
    registered,
    tools: {
      register(def) { registered.push(def); return () => { def.__disposed = true } },
    },
    // cordis semantics: effect() runs the callback immediately and keeps the
    // RETURNED disposer. (An earlier version stored the callback, so nothing ever
    // closed the MCP client and the test process never exited.)
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d) },
    runEffects() { for (const d of disposers.splice(0)) d() },
  }
}

test('splitCommand keeps quoted segments together', () => {
  assert.deepEqual(splitCommand('npx --yes @playwright/mcp@latest --cdp-endpoint=msedge'), [
    'npx', '--yes', '@playwright/mcp@latest', '--cdp-endpoint=msedge',
  ])
  assert.deepEqual(splitCommand('node "C:/a b/x.mjs" --flag'), ['node', 'C:/a b/x.mjs', '--flag'])
})

test('applyBridge registers prefixed tools from the MCP server', async () => {
  const ctx = fakeCtx()
  const defineTool = (def) => def
  const res = await applyBridge(ctx, defineTool, {
    command: `node "${FAKE}"`,
    prefix: 'edge',
    env: {},
    timeoutMs: 10000,
  })
  assert.deepEqual(res.registered.sort(), ['edge_fill_form', 'edge_navigate', 'edge_snapshot', 'edge_take_screenshot'])
  assert.deepEqual(ctx.registered.map((d) => d.name).sort(), res.registered.sort())

  const nav = ctx.registered.find((d) => d.name === 'edge_navigate')
  assert.equal(nav.parameters.url.type, 'string')
  assert.equal(nav.parameters.url.required, true)
  assert.equal(typeof nav.output.render, 'function')
  assert.deepEqual(nav.output.render({}, { ok: true }), [{ type: 'text', text: '{\n  "ok": true\n}' }])

  const out = await nav.execute({ url: 'https://example.com' })
  assert.equal(out.ok, true)
  assert.match(out.text, /navigated to https:\/\/example\.com/)
  ctx.runEffects()
})

test('applyBridge writes image content to a file instead of returning base64', async () => {
  const ctx = fakeCtx()
  const res = await applyBridge(ctx, (d) => d, {
    command: `node "${FAKE}"`, prefix: 'edge', env: {}, timeoutMs: 10000,
    allow: ['browser_take_screenshot'],
  })
  assert.deepEqual(res.registered, ['edge_take_screenshot'])
  const tool = ctx.registered[0]
  const out = await tool.execute({})
  assert.equal(out.ok, true)
  assert.equal(out.images.length, 1)
  assert.ok(existsSync(out.images[0]), 'screenshot file should exist: ' + out.images[0])
  assert.ok(!JSON.stringify(out).includes('iVBORw0KGgo'), 'base64 must not leak into the tool result')
  ctx.runEffects()
})

test('applyBridge is inert (and silent) when the server cannot start', async () => {
  const ctx = fakeCtx()
  const res = await applyBridge(ctx, (d) => d, {
    command: 'definitely-not-a-real-mcp-binary-xyz',
    prefix: 'edge', env: {}, timeoutMs: 300, initTimeoutMs: 600,
  })
  assert.deepEqual(res.registered, [])
  assert.equal(ctx.registered.length, 0)
  assert.match(String(res.error), /./)
})

test('normalizeResult handles isError and drops broken images', () => {
  assert.deepEqual(normalizeResult({ content: [{ type: 'text', text: 'hi' }] }), { ok: true, text: 'hi' })
  const bad = normalizeResult({ isError: true, content: [{ type: 'text', text: 'boom' }] })
  assert.equal(bad.ok, false)
  assert.equal(bad.text, 'boom')
})

test('client answers a call, then refuses calls after close', async () => {
  const client = createMcpClient({ command: `node "${FAKE}"`, timeoutMs: 5000 })
  await client.initialize(5000)
  const res = await client.callTool('browser_snapshot', {})
  assert.ok(Array.isArray(res.content), 'expected a content array')
  client.close()
  await assert.rejects(() => client.callTool('browser_snapshot', {}), /not running|exited/i)
})
