/**
 * Output hygiene for Playwright MCP.
 *
 * The upstream server writes every screenshot and snapshot into its output
 * directory (default `<cwd>/.playwright-mcp`) and never rotates it, so a long
 * browsing life leaves hundreds of files behind. After each successful tool
 * call the bridge keeps only the newest N, so reading the screenshot that was
 * just taken always still works.
 *
 * Env: MCP_BRIDGE_KEEP_OUTPUT (default 20, `0` = delete all). Never throws.
 */
import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

export const DEFAULT_KEEP = 20
const KEEP_EXTS = /\.(png|jpe?g|webp|ya?ml|log)$/i

/** Where the upstream writes: an explicit --output-dir, else <cwd>/.playwright-mcp. */
export function parseOutputDir(command, cwd = process.cwd()) {
  const line = String(command ?? '')
  const m = line.match(/--output-dir(?:=|\s+)("[^"]+"|'[^']+'|\S+)/)
  if (!m) return join(cwd, '.playwright-mcp')
  const value = m[1].replace(/^["']|["']$/g, '')
  return resolve(cwd, value)
}

/** MCP_BRIDGE_KEEP_OUTPUT -> integer >= 0, else the default. */
export function resolveKeep(env = process.env) {
  const raw = env.MCP_BRIDGE_KEEP_OUTPUT
  if (raw === undefined || raw === '') return DEFAULT_KEEP
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_KEEP
}

/** Keep the newest `keep` image/snapshot files in `dir`; delete the rest. */
export function pruneOutput(dir, keep = DEFAULT_KEEP) {
  if (!Number.isFinite(keep) || keep < 0) return { removed: 0, kept: 0, disabled: true }
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return { removed: 0, kept: 0, missing: true }
  }
  const files = []
  for (const name of names) {
    if (!KEEP_EXTS.test(name)) continue // leave anything we did not create
    try {
      files.push({ name, mtime: statSync(join(dir, name)).mtimeMs })
    } catch { /* vanished mid-scan */ }
  }
  files.sort((a, b) => b.mtime - a.mtime)
  let removed = 0
  for (const f of files.slice(keep)) {
    try {
      unlinkSync(join(dir, f.name))
      removed += 1
    } catch { /* ignore */ }
  }
  return { removed, kept: Math.min(files.length, keep) }
}

/** Build the callback both bridge paths run after every tool call. */
export function makePruner(command, env = process.env, cwd = process.cwd()) {
  const keep = resolveKeep(env)
  const dir = parseOutputDir(command, cwd)
  return () => pruneOutput(dir, keep)
}

/** The bridge's own copy of every image result (one per screenshot). */
export function tempImageDir() {
  return join(tmpdir(), 'dsh-mcp-bridge')
}

/** Same limit for the temp copies; `dir` is injectable for tests. */
export function pruneTempImages(keep = DEFAULT_KEEP, dir = tempImageDir()) {
  return pruneOutput(dir, keep)
}
