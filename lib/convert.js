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
  else spec.type = 'json'

  // Scalar enums are a first-class DSH constraint; passing them through keeps
  // the model on the allowed values instead of guessing. Anything odd is
  // dropped rather than risking a registration-time rejection.
  if (SIMPLE.has(node.type)
      && Array.isArray(node.enum)
      && node.enum.length > 0
      && node.enum.every((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
    spec.enum = [...node.enum]
  }

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
  const picked = []
  const seen = new Set()
  for (const t of list) {
    if (!t || typeof t.name !== 'string' || t.name === '') continue
    if (!all && allowSet && !allowSet.has(t.name)) continue
    const name = toDshName(prefix, t.name)
    // Two MCP names can map to one DSH name (`browser_navigate` and `navigate`);
    // a duplicate registration would throw mid-activation in lazy mode and
    // roll back every tool. Keep the first occurrence.
    if (seen.has(name)) continue
    seen.add(name)
    picked.push({
      mcpName: t.name,
      name,
      description: typeof t.description === 'string' ? t.description : `MCP tool ${t.name}`,
      parameters: toDshParameters(t.inputSchema),
    })
  }
  return picked
}
