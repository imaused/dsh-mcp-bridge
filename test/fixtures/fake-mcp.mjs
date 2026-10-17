#!/usr/bin/env node
// Minimal MCP stdio server used by the bridge tests. Speak NDJSON JSON-RPC.
import { createInterface } from 'node:readline'

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const TOOLS = [
  {
    name: 'browser_navigate',
    description: 'Navigate to a URL',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'The URL' } }, required: ['url'] },
  },
  { name: 'browser_snapshot', description: 'Snapshot the page', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_take_screenshot', description: 'Take a screenshot', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'browser_fill_form',
    description: 'Fill a form',
    inputSchema: { type: 'object', properties: { fields: { type: 'array', items: { type: 'object' }, description: 'fields' } } },
  },
]

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const s = line.trim()
  if (!s) return
  let req
  try { req = JSON.parse(s) } catch { return }
  if (req.id === undefined) return // notification
  const { id, method, params } = req

  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'fake-mcp', version: '0.0.1' }, capabilities: { tools: {} } } })
  }
  if (method === 'tools/list') {
    return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
  }
  if (method === 'tools/call') {
    const name = params?.name
    if (name === 'browser_take_screenshot') {
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'saved' }, { type: 'image', data: PNG_1x1, mimeType: 'image/png' }] } })
    }
    if (name === 'browser_navigate') {
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'navigated to ' + (params?.arguments?.url ?? '?') }] } })
    }
    if (name === 'browser_boom') {
      return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'boom' }] } })
    }
    return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ok:' + name }] } })
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } })
})
