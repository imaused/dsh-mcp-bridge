/**
 * Lazy exposure for MCP tools.
 *
 * One small bootstrap tool stays in the prompt; the real tools are registered
 * per Agent only after the model asks for them. This mirrors how
 * dsh-vision-toolkit and dsh-ops/discovery expose tools on demand: the catalog
 * entry is cheap, the schemas arrive when the task needs them.
 *
 * Why: a Playwright MCP server offers ~25 tools, and even the 12-tool default
 * set costs prompt surface in every session that never touches a browser.
 *
 * Unload after use: activation is not permanent. Every browser call refreshes an
 * idle timer; when it expires (`MCP_BRIDGE_RELEASE_MS`, default 3 min) the
 * per-Agent tools are disposed and the bootstrap entry becomes visible again, so
 * a session that is done browsing pays for one small schema again. Calling
 * `edge_close` (the MCP `browser_close` tool) releases immediately. The MCP child
 * process stays alive, so reloading is instant and the open browser session is
 * preserved.
 */
import {
  createMcpClient,
  buildToolDefinitions,
  killTree,
  DEFAULT_COMMAND,
  DEFAULT_ALLOW,
} from './bridge.js'
import { planTools } from './convert.js'

export const DEFAULT_BOOTSTRAP = 'edge_tools'
/** Idle window before the browser tools unload themselves again (ms). */
export const DEFAULT_RELEASE_MS = 180000

/** 180000 -> "180", 1500 -> "1.5" (log lines only) */
function seconds(ms) {
  return ms % 1000 === 0 ? String(ms / 1000) : (ms / 1000).toFixed(1)
}

/** Compact description for the bootstrap entry. Deliberately says both what it
 *  unlocks and when NOT to call it, because the whole point is prompt economy. */
export function bootstrapDescription(names, { releaseMs = 0 } = {}) {
  const lines = [
    'Load the real Edge/Chrome browser tools for this session.',
    'They are NOT loaded by default: call this only when the task actually needs',
    "to drive the browser the user is already logged into (navigate, click, type,",
    'screenshot, evaluate JS).',
    `After activation these tools appear: ${names.join(', ')}.`,
  ]
  if (releaseMs > 0) {
    lines.push(
      `They unload again after ${seconds(releaseMs)}s without a browser call;`
      + ' call this again to reload them.',
    )
  }
  lines.push('Do not call it when no browser work is needed - it only adds prompt surface.')
  return lines.join(' ')
}

/** Idle window in ms; `0` (or a non-positive / unparsable value) disables unloading. */
export function resolveReleaseMs(options = {}, env = process.env) {
  const raw = options.releaseMs ?? env.MCP_BRIDGE_RELEASE_MS ?? DEFAULT_RELEASE_MS
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Spawn the MCP server, keep a bootstrap tool registered, and register the real
 * tools per Agent on demand. Never throws: an unreachable MCP server must not
 * take the host boot down.
 */
export async function applyLazyBridge(ctx, defineTool, options = {}) {
  const env = options.env ?? process.env
  const command = options.command ?? env.MCP_BRIDGE_COMMAND ?? DEFAULT_COMMAND
  const prefix = options.prefix ?? env.MCP_BRIDGE_PREFIX ?? 'edge'
  const timeoutMs = Number(options.timeoutMs ?? env.MCP_BRIDGE_TIMEOUT ?? 120000)
  const initTimeoutMs = Number(options.initTimeoutMs ?? env.MCP_BRIDGE_INIT_TIMEOUT ?? 30000)
  const all = options.all ?? env.MCP_BRIDGE_ALL === '1'
  const bootstrapName = options.bootstrapName ?? env.MCP_BRIDGE_BOOTSTRAP ?? DEFAULT_BOOTSTRAP
  const releaseMs = resolveReleaseMs(options, env)
  const allow = options.allow ?? (env.MCP_BRIDGE_TOOLS
    ? env.MCP_BRIDGE_TOOLS.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_ALLOW)

  const client = createMcpClient({ command, env, timeoutMs })
  const states = new Map()
  let bootstrapDispose
  let offDisposed
  let closed = false

  function clearTimer(state) {
    if (state?.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
  }

  function disposeAgent(agent) {
    const state = states.get(agent)
    if (state === undefined) return
    clearTimer(state)
    states.delete(agent)
    try { state.lift?.() } catch { /* ignore */ }
    for (const dispose of state.disposers.reverse()) {
      try { dispose() } catch { /* ignore */ }
    }
    state.disposers = []
  }

  /** Unload one Agent's browser tools and make the bootstrap entry visible again. */
  function releaseAgent(agent, reason) {
    const state = states.get(agent)
    if (state === undefined) return false
    const count = state.names.length
    disposeAgent(agent)
    console.error(
      `[mcp-bridge] released ${count} browser tools after ${reason};`
      + ` ${bootstrapName} is visible again`,
    )
    return true
  }

  /** (Re)start the idle countdown for an Agent that has the tools loaded. */
  function armRelease(agent) {
    if (releaseMs <= 0) return
    const state = states.get(agent)
    if (state === undefined || !state.active) return
    clearTimer(state)
    state.timer = setTimeout(() => {
      const current = states.get(agent)
      if (current !== undefined) current.timer = undefined
      releaseAgent(agent, `${seconds(releaseMs)}s idle`)
    }, releaseMs)
    // Never keep the host event loop alive just for this countdown.
    state.timer.unref?.()
  }

  function activate(agent) {
    let state = states.get(agent)
    if (state === undefined) {
      state = { active: false, disposers: [], names: [], timer: undefined }
      states.set(agent, state)
    }
    if (state.active) return { activated: false, tools: [...state.names] }

    const closePlanned = planned.find((tool) => tool.mcpName === 'browser_close')
    const definitions = buildToolDefinitions(defineTool, planned, client, {
      onCall(name) {
        if (closePlanned !== undefined && name === closePlanned.name) {
          // Closing the page ends the browsing task: unload right after this call
          // returns (deferred a tick so the close result itself still arrives).
          const timer = setTimeout(() => { releaseAgent(agent, 'browser close') }, 0)
          timer.unref?.()
          return
        }
        armRelease(agent)
      },
    })
    const disposers = []
    try {
      for (const definition of definitions) {
        disposers.push(agent.ctx.tools.register(definition))
      }
    } catch (error) {
      for (const dispose of disposers.reverse()) {
        try { dispose() } catch { /* ignore */ }
      }
      throw error
    }

    state.disposers = disposers
    state.names = definitions.map((definition) => definition.name)
    state.active = true
    // The bootstrap entry has done its job for this Agent; hide it so the
    // prompt returns to a single, smaller surface.
    try { state.lift = agent.ctx.tools.restrict({ deny: [bootstrapName] }) } catch { /* ignore */ }
    armRelease(agent)
    return { activated: true, tools: [...state.names] }
  }

  const close = () => {
    if (closed) return
    closed = true
    for (const agent of [...states.keys()]) disposeAgent(agent)
    try { bootstrapDispose?.() } catch { /* ignore */ }
    try { offDisposed?.() } catch { /* ignore */ }
    client.close()
  }

  let planned = []
  try {
    const init = await client.initialize(initTimeoutMs)
    const tools = await client.listTools()
    planned = planTools(tools, { prefix, allow, all })

    const bootstrap = defineTool({
      name: bootstrapName,
      description: bootstrapDescription(planned.map((tool) => tool.name), { releaseMs }),
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            activated: { type: 'boolean', required: true },
            tools: { type: 'array', items: { type: 'string' }, required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute: async (_args, exec) => {
        if (exec.agent === undefined) {
          throw new Error(`${bootstrapName}: an Agent Session is required`)
        }
        return activate(exec.agent)
      },
      presentCall: () => ({ card: 'generic', title: 'Load Edge browser tools', kind: 'execute' }),
    })
    bootstrapDispose = ctx.tools.register(bootstrap)

    if (typeof ctx.on === 'function') {
      offDisposed = ctx.on('agent/disposed', ({ agent }) => { disposeAgent(agent) })
    }

    if (typeof ctx.effect === 'function') ctx.effect(() => close)
    else process.on('exit', close)
    process.on('exit', () => { try { killTree(client.child) } catch { /* ignore */ } })

    console.error(
      `[mcp-bridge] lazy mode: 1 bootstrap tool (${bootstrapName}), ${planned.length}/${tools.length} tools`
      + ` from ${init?.serverInfo?.name || 'MCP'} (prefix "${prefix}";`
      + ` unload after ${releaseMs > 0 ? `${seconds(releaseMs)}s idle` : 'disabled'})`,
    )
    return {
      registered: [bootstrapName],
      mode: 'lazy',
      total: tools.length,
      tools: planned.map((tool) => tool.name),
      releaseMs,
    }
  } catch (e) {
    console.error(`[mcp-bridge] not available: ${e.message}; stderr tail: ${client.stderrTail.slice(-600)}`)
    client.close()
    return { registered: [], total: 0, mode: 'lazy', error: String(e.message || e) }
  }
}
