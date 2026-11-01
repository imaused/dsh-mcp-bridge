import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildToolDefinitions } from '../lib/bridge.js'

test('buildToolDefinitions runs afterCall for every executed tool', async () => {
  const seen = []
  const client = { callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }
  const planned = [{ name: 'edge_x', mcpName: 'browser_x', description: 'd', parameters: {} }]
  const defs = buildToolDefinitions((d) => d, planned, client, { afterCall: (name) => seen.push(name) })
  await defs[0].execute({})
  assert.deepEqual(seen, ['edge_x'])
})

test('afterCall runs even when the upstream call fails', async () => {
  const seen = []
  const client = { callTool: async () => { throw new Error('boom') } }
  const planned = [{ name: 'edge_y', mcpName: 'browser_y', description: 'd', parameters: {} }]
  const defs = buildToolDefinitions((d) => d, planned, client, { afterCall: (name) => seen.push(name) })
  const res = await defs[0].execute({})
  assert.equal(res.ok, false)
  assert.deepEqual(seen, ['edge_y'])
})
