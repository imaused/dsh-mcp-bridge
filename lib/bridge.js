/**
 * MCP (Model Context Protocol) stdio client + DSH tool registration.
 *
 * Zero npm dependencies: JSON-RPC 2.0 over newline-delimited JSON on the child's
 * stdin/stdout. The bridge spawns ONE long-lived MCP server process per plugin
 * instance and forwards every tool call to it.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { planTools } from './convert.js'

export const DEFAULT_COMMAND = 'npx --yes @playwright/mcp@latest --cdp-endpoint=msedge'

/** Tools exposed by default. The full Playwright set is 25 tools, which is a lot of
 *  prompt surface in every session; these are the ones a browsing task actually needs.
 *  Set MCP_BRIDGE_ALL=1 to expose everything. */
export const DEFAULT_ALLOW = [
  'browser_navigate',
  'browser_navigate_back',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_fill_form',
  'browser_press_key',
  'browser_tabs',
  'browser_take_screenshot',
  'browser_evaluate',
  'browser_wait_for',
  'browser_close',
]

export function splitCommand(command) {
  return String(command)
    .match(/"[^"]*"|'[^']*'|\S+/g)
    ?.map((s) => s.replace(/^["']|["']$/g, '')) ?? []
}

/** Kill the whole process tree. On Windows with shell:true the pid is cmd.exe, and
 *  killing only that leaves the real server (a grandchild) holding our pipes open —
 *  which keeps the host's event loop alive. taskkill /T is the reliable fix. */
export function killTree(child) {
  if (!child || child.killed) return
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      return
    }
    child.kill('SIGKILL')
  } catch { /* ignore */ }
}

export function createMcpClient({ command = DEFAULT_COMMAND, env = process.env, timeoutMs = 120000, cwd } = {}) {
  const parts = splitCommand(command)
  const [exe, ...args] = parts
  if (!exe) throw new Error('MCP_BRIDGE_COMMAND is empty')

  const child = spawn(exe, args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32', // npx is a .cmd shim on Windows
    windowsHide: true,
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  const stderrTail = []
  child.stderr.on('data', (d) => {
    stderrTail.push(d)
    if (stderrTail.join('').length > 16_000) stderrTail.splice(0, stderrTail.length - 8)
  })
  child.on('error', (e) => stderrTail.push(`[spawn error] ${e.message}\n`))

  const pending = new Map()
  let seq = 0
  let closed = false

  createInterface({ input: child.stdout }).on('line', (line) => {
    const s = line.trim()
    if (!s) return
    let msg
    try { msg = JSON.parse(s) } catch { return }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      clearTimeout(p.timer)
      pending.delete(msg.id)
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
    }
  })

  child.on('exit', (code) => {
    closed = true
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error(`MCP server exited with code ${code}`))
    }
    pending.clear()
  })

  function rpc(method, params, perCallTimeout = timeoutMs) {
    if (closed) return Promise.reject(new Error('MCP server is not running'))
    const id = ++seq
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`MCP timeout after ${perCallTimeout}ms in ${method}`))
      }, perCallTimeout)
      pending.set(id, { resolve, reject, timer })
    })
  }

  const notify = (method, params) =>
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')

  return {
    child,
    get stderrTail() { return stderrTail.join('') },
    async initialize(initTimeout = 30000) {
      const res = await rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'dsh-mcp-bridge', version: '0.1.0' },
      }, initTimeout)
      notify('notifications/initialized', {})
      return res
    },
    async listTools() {
      const res = await rpc('tools/list', {})
      return Array.isArray(res?.tools) ? res.tools : []
    },
    async callTool(name, args) {
      return rpc('tools/call', { name, arguments: args ?? {} })
    },
    close() {
      if (closed) return
      closed = true
      try { child.stdin.end() } catch { /* ignore */ }
      killTree(child)
    },
  }
}

/** Turn an MCP tools/call result into a JSON-safe DSH tool result.
 *  Image content is written to a temp file and returned as a path, because a
 *  base64 screenshot would blow up the conversation. */
export function normalizeResult(result) {
  const content = Array.isArray(result?.content) ? result.content : []
  const texts = []
  const images = []
  for (const c of content) {
    if (c?.type === 'text' && typeof c.text === 'string') texts.push(c.text)
    if (c?.type === 'image' && typeof c.data === 'string') {
      try {
        const dir = join(tmpdir(), 'dsh-mcp-bridge')
        mkdirSync(dir, { recursive: true })
        const file = join(dir, `shot-${Date.now()}-${images.length}.png`)
        writeFileSync(file, Buffer.from(c.data, 'base64'))
        images.push(file)
      } catch (e) {
        texts.push(`[image dropped: ${e.message}]`)
      }
    }
  }
  return {
    ok: result?.isError !== true,
    text: texts.join('\n').slice(0, 20000),
    ...(images.length ? { images } : {}),
  }
}

/** Build DSH tool definitions from planned MCP tools. Shared by the eager and
 *  lazy paths so a tool behaves identically however it was exposed. */
export function buildToolDefinitions(defineTool, planned, client) {
  return planned.map((p) => defineTool({
    name: p.name,
    description: `${p.description}\n\n[via MCP]`,
    parameters: p.parameters,
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      try {
        return normalizeResult(await client.callTool(p.mcpName, args ?? {}))
      } catch (e) {
        return { ok: false, error: { code: 'mcp_call_failed', message: String(e.message || e) } }
      }
    },
  }))
}

/**
 * Spawn the MCP server, list its tools, and register them on ctx.tools.
 * Never throws: a bridge that cannot start must not take the host boot with it.
 */
export async function applyBridge(ctx, defineTool, options = {}) {
  const env = options.env ?? process.env
  const command = options.command ?? env.MCP_BRIDGE_COMMAND ?? DEFAULT_COMMAND
  const prefix = options.prefix ?? env.MCP_BRIDGE_PREFIX ?? 'edge'
  const timeoutMs = Number(options.timeoutMs ?? env.MCP_BRIDGE_TIMEOUT ?? 120000)
  const initTimeoutMs = Number(options.initTimeoutMs ?? env.MCP_BRIDGE_INIT_TIMEOUT ?? 30000)
  const all = options.all ?? env.MCP_BRIDGE_ALL === '1'
  const allow = options.allow ?? (env.MCP_BRIDGE_TOOLS
    ? env.MCP_BRIDGE_TOOLS.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_ALLOW)

  const client = createMcpClient({ command, env, timeoutMs })
  let disposers = []
  try {
    const init = await client.initialize(initTimeoutMs)
    const tools = await client.listTools()
    const planned = planTools(tools, { prefix, allow, all })

    for (const def of buildToolDefinitions(defineTool, planned, client)) {
      try {
        const dispose = ctx.tools.register(def)
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (e) {
        console.error(`[mcp-bridge] failed to register ${def.name}: ${e.message}`)
      }
    }

    const close = () => {
      for (const d of disposers) { try { d() } catch { /* ignore */ } }
      disposers = []
      client.close()
    }
    if (typeof ctx.effect === 'function') ctx.effect(() => close)
    else process.on('exit', close)
    process.on('exit', () => { try { killTree(client.child) } catch { /* ignore */ } })

    console.error(`[mcp-bridge] ${planned.length}/${tools.length} tools registered from ${init?.serverInfo?.name || 'MCP'} (prefix "${prefix}")`)
    return { registered: planned.map((p) => p.name), total: tools.length }
  } catch (e) {
    console.error(`[mcp-bridge] not available: ${e.message}; stderr tail: ${client.stderrTail.slice(-600)}`)
    client.close()
    return { registered: [], total: 0, error: String(e.message || e) }
  }
}
