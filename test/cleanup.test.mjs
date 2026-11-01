import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readdirSync, utimesSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { pruneOutput, parseOutputDir, resolveKeep, DEFAULT_KEEP, makePruner, pruneTempImages } from '../lib/cleanup.js'

function fixture(specs) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-cleanup-'))
  const t0 = Date.now() - specs.length * 1000
  specs.forEach((name, i) => {
    writeFileSync(join(dir, name), 'x')
    const t = new Date(t0 + i * 1000)
    utimesSync(join(dir, name), t, t)
  })
  return dir
}

test('pruneOutput keeps the newest N files and ignores foreign types', () => {
  const dir = fixture(['old.png', 'old.yml', 'old.log', 'mid.png', 'new.png', 'notes.txt'])
  // mtimes ascend with the list, so newest first: new.png, mid.png, old.log, old.yml, old.png
  const res = pruneOutput(dir, 2)
  assert.equal(res.kept, 2)
  assert.equal(res.removed, 3)
  const left = readdirSync(dir).sort()
  assert.deepEqual(left, ['mid.png', 'new.png', 'notes.txt'])
  rmSync(dir, { recursive: true, force: true })
})

test('keep 0 deletes every managed file but leaves foreign ones', () => {
  const dir = fixture(['a.png', 'b.webp', 'c.jpeg', 'keep.md'])
  const res = pruneOutput(dir, 0)
  assert.equal(res.removed, 3)
  assert.deepEqual(readdirSync(dir), ['keep.md'])
  rmSync(dir, { recursive: true, force: true })
})

test('pruneOutput is a no-op when the directory does not exist', () => {
  const res = pruneOutput(join(tmpdir(), 'mcp-cleanup-does-not-exist-xyz'), 5)
  assert.deepEqual(res, { removed: 0, kept: 0, missing: true })
})

test('parseOutputDir reads --output-dir and falls back to <cwd>/.playwright-mcp', () => {
  const cwd = resolve('profile-dir')
  assert.equal(parseOutputDir('npx @playwright/mcp', cwd), join(cwd, '.playwright-mcp'))
  assert.equal(parseOutputDir('npx @playwright/mcp --output-dir "shots"', cwd), resolve(cwd, 'shots'))
  assert.equal(parseOutputDir('npx @playwright/mcp --output-dir=shots', cwd), resolve(cwd, 'shots'))
})

test('resolveKeep reads the env safely', () => {
  assert.equal(resolveKeep({}), DEFAULT_KEEP)
  assert.equal(resolveKeep({ MCP_BRIDGE_KEEP_OUTPUT: '5' }), 5)
  assert.equal(resolveKeep({ MCP_BRIDGE_KEEP_OUTPUT: '0' }), 0)
  assert.equal(resolveKeep({ MCP_BRIDGE_KEEP_OUTPUT: 'nope' }), DEFAULT_KEEP)
  assert.equal(resolveKeep({ MCP_BRIDGE_KEEP_OUTPUT: '-3' }), DEFAULT_KEEP)
})

test('makePruner uses the command output dir and the env limit', () => {
  const dir = fixture(['a.png', 'b.png', 'c.png'])
  const prune = makePruner(`npx @playwright/mcp --output-dir "${dir}"`, { MCP_BRIDGE_KEEP_OUTPUT: '1' })
  assert.equal(existsSync(join(dir, 'a.png')), true)
  const res = prune()
  assert.equal(res.kept, 1)
  assert.equal(readdirSync(dir).length, 1)
  rmSync(dir, { recursive: true, force: true })
})

test('pruneTempImages prunes the bridge temp copies', () => {
  const dir = fixture(['s1.png', 's2.png', 's3.png'])
  const res = pruneTempImages(1, dir)
  assert.equal(res.removed, 2)
  assert.equal(res.kept, 1)
  assert.equal(readdirSync(dir).length, 1)
  rmSync(dir, { recursive: true, force: true })
})
