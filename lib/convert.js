/**
 * JSON Schema (MCP tool.inputSchema) -> DSH `parameters` DSL.
 *
 * DSH parameter types: string | number | integer | boolean | null | array | object | json | oneOf.
 * Anything we cannot map with certainty becomes `json` (author-only passthrough), which
 * cannot fail validation at registration time.
 */

const SIMPLE = new Set(['string', 'number', 'integer', 'boolean'])

export function propertySpec(node) {
  if (!node || typeof node !== 'object') return { type: 'json' }
  const spec = {}
  if (SIMPLE.has(node.type)) spec.type = node.type
  else if (node.type === 'array' && Array.isArray(node.enum)) spec.type = 'string'
  else spec.type = 'json'

  if (typeof node.description === 'string' && node.description.trim()) {
    spec.description = node.description.trim()
  }
  return spec
}

export function toDshParameters(inputSchema) {
  const schema = inputSchema && typeof inputSchema === 'object' ? inputSchema : {}
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {}
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  const out = {}
  for (const [name, node] of Object.entries(props)) {
    const spec = propertySpec(node)
    if (required.has(name)) spec.required = true
    out[name] = spec
  }
  return out
}

/** `browser_navigate` -> `edge_navigate` when prefix is `edge`. */
export function toDshName(prefix, mcpName) {
  const short = String(mcpName).replace(/^browser_/, '')
  return `${prefix}_${short}`
}

/**
 * Pick which MCP tools to expose, and give each a DSH name + parameter schema.
 * `allow` (array) keeps only those MCP names; `all: true` keeps everything.
 */
export function planTools(tools, { prefix = 'mcp', allow = null, all = false } = {}) {
  const list = Array.isArray(tools) ? tools : []
  const allowSet = Array.isArray(allow) && allow.length ? new Set(allow) : null
  const picked = list.filter((t) => (all || !allowSet ? true : allowSet.has(t.name)))
  return picked.map((t) => ({
    mcpName: t.name,
    name: toDshName(prefix, t.name),
    description: typeof t.description === 'string' ? t.description : `MCP tool ${t.name}`,
    parameters: toDshParameters(t.inputSchema),
  }))
}
