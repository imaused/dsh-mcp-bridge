# Security model — dsh-mcp-host 0.1.3

One host-only DSH plugin. It registers tools that forward calls to **one** child process: the MCP server named by `MCP_BRIDGE_COMMAND`.

## What it spawns

```js
spawn(exe, args, { cwd, env, stdio: ['pipe','pipe','pipe'], shell: process.platform === 'win32', windowsHide: true })
```

- `exe` and `args` come from splitting `MCP_BRIDGE_COMMAND` (default: `npx --yes @playwright/mcp@latest --cdp-endpoint=msedge`).
- `shell: true` **only on Windows**, because `npx` is a `.cmd` shim there. On that path the command line is fixed by the operator, not by the model.
- No other child processes. No ports. No file watchers.

## What it reads / writes

- Reads: the child's stdout (JSON-RPC) and stderr (kept as a bounded tail for error messages).
- Writes: the child's stdin. Screenshots returned as MCP `image` content are written to `%TEMP%\dsh-mcp-host\` and the path is returned; base64 never enters the conversation.

## What it downloads

Nothing. `npx` may download `@playwright/mcp` on first run — that is the operator's command, not hidden behaviour.

## Failure containment

`apply()` returns a promise that never rejects. On any start-up failure the plugin registers zero tools and logs one line. A broken MCP server cannot abort DSH's boot.

## Verification

```powershell
# the only spawn site
Select-String -Path lib\bridge.js -Pattern "spawn\("
# no network primitives in the bridge itself
Select-String -Path lib\*.js -Pattern "http|fetch|net\.|socket"
# the registered tools exist because the server answered tools/list
node --test "test/*.test.mjs"
```
