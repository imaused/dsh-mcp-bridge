import { defineTool } from '@deepseek-ai/dsh-tools'

import { applyBridge } from './bridge.js'
import { applyLazyBridge } from './lazy.js'

export const name = 'mcp-bridge'
export const inject = ['tools']

export function apply(ctx) {
  // Default: one bootstrap tool in the prompt, real tools on demand.
  // MCP_BRIDGE_EAGER=1 restores the old eager registration for debugging.
  const eager = process.env.MCP_BRIDGE_EAGER === '1'
  const run = eager ? applyBridge : applyLazyBridge
  // Never reject: a bridge that cannot reach its MCP server must not abort the host boot.
  return run(ctx, defineTool).catch((e) => {
    console.error('[mcp-bridge] unexpected failure:', e?.message || e)
    return { registered: [], total: 0, error: String(e?.message || e) }
  })
}
