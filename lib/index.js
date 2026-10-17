import { defineTool } from '@deepseek-ai/dsh-tools'

import { applyBridge } from './bridge.js'

export const name = 'mcp-bridge'
export const inject = ['tools']

export function apply(ctx) {
  // Never reject: a bridge that cannot reach its MCP server must not abort the host boot.
  return applyBridge(ctx, defineTool).catch((e) => {
    console.error('[mcp-bridge] unexpected failure:', e?.message || e)
    return { registered: [], total: 0, error: String(e?.message || e) }
  })
}
