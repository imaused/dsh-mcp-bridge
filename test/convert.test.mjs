import { test } from 'node:test'
import assert from 'node:assert/strict'

import { propertySpec, toDshParameters, toDshName, planTools } from '../lib/convert.js'

test('propertySpec maps simple types and keeps descriptions', () => {
  assert.deepEqual(propertySpec({ type: 'string', description: ' a url ' }), { type: 'string', description: 'a url' })
  assert.deepEqual(propertySpec({ type: 'integer' }), { type: 'integer' })
  assert.deepEqual(propertySpec({ type: 'boolean', description: 'x' }), { type: 'boolean', description: 'x' })
})

test('propertySpec falls back to json for anything unmappable', () => {
  assert.deepEqual(propertySpec({ type: 'array', items: { type: 'string' } }), { type: 'json' })
  assert.deepEqual(propertySpec({ type: 'object', properties: {} }), { type: 'json' })
  assert.deepEqual(propertySpec({ oneOf: [{ type: 'string' }, { type: 'number' }] }), { type: 'json' })
  assert.deepEqual(propertySpec(undefined), { type: 'json' })
})

test('toDshParameters honours required[]', () => {
  const params = toDshParameters({
    type: 'object',
    properties: {
      url: { type: 'string', description: 'u' },
      timeout: { type: 'integer' },
      fields: { type: 'array' },
    },
    required: ['url'],
  })
  assert.deepEqual(params.url, { type: 'string', description: 'u', required: true })
  assert.deepEqual(params.timeout, { type: 'integer' })
  assert.deepEqual(params.fields, { type: 'json' })
})

test('toDshParameters tolerates a missing/odd schema', () => {
  assert.deepEqual(toDshParameters(undefined), {})
  assert.deepEqual(toDshParameters({ type: 'object' }), {})
  assert.deepEqual(toDshParameters({ properties: { a: null } }), { a: { type: 'json' } })
})

test('toDshName strips the browser_ prefix and applies the prefix', () => {
  assert.equal(toDshName('edge', 'browser_navigate'), 'edge_navigate')
  assert.equal(toDshName('mcp', 'browser_snapshot'), 'mcp_snapshot')
  assert.equal(toDshName('edge', 'custom_thing'), 'edge_custom_thing')
})

test('planTools filters by allow-list unless all=true', () => {
  const tools = [
    { name: 'browser_navigate', description: 'n', inputSchema: { properties: { url: { type: 'string' } }, required: ['url'] } },
    { name: 'browser_snapshot', description: 's', inputSchema: { properties: {} } },
    { name: 'browser_take_screenshot', description: 't', inputSchema: { properties: {} } },
  ]
  const picked = planTools(tools, { prefix: 'edge', allow: ['browser_navigate', 'browser_snapshot'] })
  assert.deepEqual(picked.map((p) => p.name), ['edge_navigate', 'edge_snapshot'])
  assert.equal(picked[0].parameters.url.required, true)
  assert.equal(planTools(tools, { prefix: 'edge', all: true }).length, 3)
  assert.equal(planTools(tools, { prefix: 'edge', allow: [] }).length, 3, 'empty allow-list means everything')
  assert.equal(planTools(tools, { prefix: 'edge', allow: ['nope'] }).length, 0)
})
