# dsh-mcp-host

Expose **any stdio MCP server** as native DeepSeek Harness tools. Host-only plugin, no browser UI, no npm dependencies.

Built for one job: let a DSH agent drive a browser through the official **Microsoft Playwright MCP** server, attached to the Edge/Chrome you are already using.

> **0.4.0** — the browser tools unload when the browsing turn ends (and right after `edge_close`); later requests carry only `edge_tools`. The MCP process and the open browser session stay alive, so reloading is one cheap call. See [Unload after use](#unload-after-use-default).

## What it does

1. On load, spawns the MCP server once (default `npx --yes @playwright/mcp@latest --cdp-endpoint=msedge`) and calls `initialize` + `tools/list`.
2. Registers **one** bootstrap tool, `edge_tools` (name configurable). Its description is deliberately short and states when to call it — and when not to.
3. When the model calls `edge_tools`, the bridge registers the real `edge_*` tools **for that Agent only**, hides the bootstrap entry, and forwards every call to MCP `tools/call`. Screenshots are written to a temp file and returned as a path, not as base64.
4. **Unload after use**: when that turn ends (`session/event` → `turn/end`), the per-Agent tools are removed and `edge_tools` becomes visible again, so every later request is back to one small schema. `edge_close` releases immediately, and an idle countdown (`MCP_BRIDGE_RELEASE_MS`, default 3 min) is the backstop. The MCP process and the open browser session stay alive, so reloading is one cheap call. On `agent/disposed` (and on plugin dispose) the same teardown runs.

Tools are renamed: `browser_navigate` becomes `edge_navigate` (prefix configurable).

## Lazy loading (default)

The 12-tool default set is **not** in the prompt until a browsing task needs it. A session that never touches a browser pays for one small schema (`edge_tools`), not twelve.

- Set `MCP_BRIDGE_EAGER=1` to restore the old behaviour (register every tool at boot).
- Activation is per Agent: the parent session and each subagent must call `edge_tools` independently.
- After activation the bootstrap entry is hidden for that Agent (`tools.restrict({ deny })`), so the prompt goes back to a single, smaller surface.

## Unload after use (default)

Loading is temporary, so a session that browsed once does not carry twelve schemas forever:

- **Primary trigger: the end of the turn.** As soon as the session emits `turn/end`, that Agent's tools are disposed and `edge_tools` appears again — the next request only pays for the small bootstrap schema. The next browsing turn reloads them with one call.
- **`edge_close`**: immediate unload (the page is closed, so the burst is over).
- **Idle backstop**: if no `turn/end` ever arrives (non-interactive hosts, long-lived agents), the tools also unload after `MCP_BRIDGE_RELEASE_MS` without a browser call. `0` disables the backstop.
- The MCP server process is **not** killed and the browser stays open — only the prompt surface shrinks, and reloading keeps tabs, logins and history.
- `MCP_BRIDGE_RELEASE_ON_TURN_END=0` (with `MCP_BRIDGE_RELEASE_MS=0`) restores the 0.2.0 behaviour: tools stay for the whole Agent lifetime.

## Default tool set (12 of Playwright's 25)

`edge_navigate`, `edge_navigate_back`, `edge_snapshot`, `edge_click`, `edge_type`, `edge_fill_form`, `edge_press_key`, `edge_tabs`, `edge_take_screenshot`, `edge_evaluate`, `edge_wait_for`, `edge_close`.

Set `MCP_BRIDGE_ALL=1` to expose everything the server offers.

## Screenshots: image, path, or both

Playwright MCP ≥ 0.0.83 saves every screenshot to disk and returns text containing the path (`[Screenshot of viewport](.playwright-mcp\page-....png)`), plus an image part unless told otherwise. The path is relative to the MCP server's working directory (on this machine the profile dir) unless `MCP_BRIDGE_COMMAND` sets an absolute `--output-dir`.

**This plugin never forwards that image part.** `normalizeResult` writes images to a temp file and every tool renders JSON text, so the model sees a path (~26 tokens), not an image. A screenshot has always been cheap here.

So `MCP_BRIDGE_IMAGES` does **not** save context in DSH. What it buys:

- `MCP_BRIDGE_IMAGES=omit` — the upstream stops sending the image at all: ~12 K fewer base64 characters over stdio per screenshot, and one less duplicate temp file. Pick it when the agent never looks at the picture. **Caveat:** with `omit` the only path is the relative one inside the text, because the plugin's absolute temp copy (`images[]`) only exists in the default mode — an agent that wants to open screenshots should keep `allow`.
- `MCP_BRIDGE_IMAGES=only` — keep the image, drop the accompanying text.
- Appended **only** to Playwright MCP command lines (`@playwright/mcp` or `playwright-mcp`); other servers are left untouched, and an explicit `--image-responses` inside `MCP_BRIDGE_COMMAND` always wins.
- Default is unchanged (`allow`).

Context only suffers where a client renders MCP image content (Claude Code, Cursor, …): there a 1280×720 capture is ~1.2k tokens. Those clients do not use this plugin — set `--image-responses=omit` in their own MCP config instead.

## Output hygiene

Playwright MCP writes every screenshot and accessibility snapshot into its output directory (`--output-dir`, default `<cwd>/.playwright-mcp`) and never rotates it, so a long browsing life leaves hundreds of files behind. After every tool call the bridge keeps the newest `MCP_BRIDGE_KEEP_OUTPUT` files (default 20) and deletes older `.png/.jpg/.jpeg/.webp/.yml/.yaml/.log` files; anything else in that directory is left alone. The screenshot just taken is always the newest, so reading it still works. `0` deletes all managed files; a missing directory or an unparsable value is a no-op.

## Install

From npm (published as `dsh-mcp-host`):

```powershell
dsh plugin --profile web add dsh-mcp-host
```

From a local checkout (development):

```powershell
cd E:\dsh
.\rollback.cmd guard add "file:E:\dsh\dsh-mcp-bridge"
.\rollback.cmd health
```

Restart DSH (or rely on hot-load) and open a new session. The default MCP command uses
`npx`, so Node.js (which ships `npx`) must be on PATH; the first call downloads
`@playwright/mcp` from npm.

## Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `MCP_BRIDGE_COMMAND` | `npx --yes @playwright/mcp@latest --cdp-endpoint=msedge` | The MCP server command line (any stdio MCP server) |
| `MCP_BRIDGE_PREFIX` | `edge` | Tool name prefix |
| `MCP_BRIDGE_BOOTSTRAP` | `edge_tools` | Name of the single lazy-loading entry tool |
| `MCP_BRIDGE_RELEASE_ON_TURN_END` | `1` | `0` = do not unload at turn end (idle backstop only) |
| `MCP_BRIDGE_RELEASE_MS` | `180000` | Idle ms before the browser tools unload themselves again (backstop; `0` = off) |
| `MCP_BRIDGE_EAGER` | unset | `1` = register every tool at boot (old behaviour, no bootstrap) |
| `MCP_BRIDGE_ALL` | unset | `1` = expose every tool the server offers |
| `MCP_BRIDGE_IMAGES` | unset | `omit` = upstream sends no image (the text keeps the path; saves the transfer and a duplicate temp file — **no context change in DSH**), `only` = drop the text; Playwright MCP commands only |
| `MCP_BRIDGE_KEEP_OUTPUT` | `20` | Newest N files kept in Playwright's output dir after each call; `0` = delete all managed files |
| `MCP_BRIDGE_TOOLS` | unset | Comma-separated allow-list of MCP tool names |
| `MCP_BRIDGE_TIMEOUT` | `120000` | Per-call timeout (ms) |
| `MCP_BRIDGE_INIT_TIMEOUT` | `30000` | Startup timeout (ms) |

## Prerequisite for the Edge/Chrome you are already using

Open `edge://inspect/#remote-debugging` (or `chrome://inspect/#remote-debugging`) and enable **Allow remote debugging for this browser instance**. Then `--cdp-endpoint=msedge` (or `=chrome`) attaches to that running browser with your logins and extensions. Without the toggle, Playwright launches a fresh browser instead.

## Failure behaviour

If the MCP server cannot start or does not answer, the plugin **registers nothing and logs the reason** — it never throws, so it cannot take the host boot down. Check `MCP_BRIDGE_INIT_TIMEOUT` and the stderr tail printed in the DSH console.

## Privacy

The bridge itself makes no network calls. It spawns exactly one child process (the MCP server you configured) and forwards bytes between it and the tool call. With `--cdp-endpoint`, the MCP server attaches to your existing browser, which means it can see and act on the tabs you have open — treat that as giving the agent your browser session.

## License

MIT.
