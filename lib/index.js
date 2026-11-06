import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { applyBridge } from './bridge.js'
import { applyLazyBridge } from './lazy.js'

export const name = 'mcp-bridge'
export const inject = ['tools']

/**
 * Resolve `defineTool` without a hard top-level dependency on one DSH layout.
 * A static import aborts the whole plugin module when the package layout or
 * the export name changes; this keeps the failure local and the host booting.
 */
async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    if (typeof mod.defineTool === 'function') return mod.defineTool
  } catch {
    // fall through to the bundled copy
  }
  const resources = process.resourcesPath
  if (typeof resources === 'string' && resources !== '') {
    const relative = ['dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js']
    for (const prefix of ['app.asar', 'app.asar.unpacked', 'app']) {
      try {
        const entry = pathToFileURL(path.join(resources, prefix, ...relative)).href
        const mod = await import(entry)
        if (typeof mod.defineTool === 'function') return mod.defineTool
      } catch {
        // try the next layout
      }
    }
  }
  return undefined
}

const defineTool = await loadDefineTool()

export function apply(ctx) {
  if (typeof defineTool !== 'function') {
    try {
      ctx?.logger?.warn?.(
        '[mcp-bridge] @deepseek-ai/dsh-tools not found; tools not registered (host unaffected)',
      )
    } catch {
      // nothing else to do
    }
    return undefined
  }
  // Default: one bootstrap tool in the prompt, real tools on demand.
  // MCP_BRIDGE_EAGER=1 restores the old eager registration for debugging.
  const eager = process.env.MCP_BRIDGE_EAGER === '1'
  const run = eager ? applyBridge : applyLazyBridge
  // Never reject: a bridge that cannot reach its MCP server must not abort the host boot.
  return Promise.resolve()
    .then(() => run(ctx, defineTool))
    .catch((e) => {
      console.error('[mcp-bridge] unexpected failure:', e?.message || e)
      return { registered: [], total: 0, error: String(e?.message || e) }
    })
}
