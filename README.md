# dsh-mcp-bridge

Expose **any stdio MCP server** as native DeepSeek Harness tools. Host-only plugin, no browser UI, no npm dependencies.

Built for one job: let a DSH agent drive a browser through the official **Microsoft Playwright MCP** server, attached to the Edge/Chrome you are already using.

## What it does

1. On load, spawns the MCP server once (default `npx --yes @playwright/mcp@latest --cdp-endpoint=msedge`).
2. Calls `initialize` + `tools/list`, converts each tool's JSON Schema into a DSH parameter schema, and registers it with `ctx.tools.register`.
3. Every tool call is forwarded as `tools/call`; the result is returned as JSON. Images (screenshots) are written to a temp file and returned as a path, not as base64.

Tools are renamed: `browser_navigate` becomes `edge_navigate` (prefix configurable).

## Default tool set (12 of Playwright's 25)

`edge_navigate`, `edge_navigate_back`, `edge_snapshot`, `edge_click`, `edge_type`, `edge_fill_form`, `edge_press_key`, `edge_tabs`, `edge_take_screenshot`, `edge_evaluate`, `edge_wait_for`, `edge_close`.

The full set costs prompt space in every session, which is why it is not the default. Set `MCP_BRIDGE_ALL=1` to expose everything.

## Install

```powershell
cd E:\dsh
.\rollback.cmd guard add "file:C:\path\to\dsh-mcp-bridge"
.\rollback.cmd health
```

Restart DSH (or rely on hot-load) and open a new session.

## Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `MCP_BRIDGE_COMMAND` | `npx --yes @playwright/mcp@latest --cdp-endpoint=msedge` | The MCP server command line (any stdio MCP server) |
| `MCP_BRIDGE_PREFIX` | `edge` | Tool name prefix |
| `MCP_BRIDGE_ALL` | unset | `1` = register every tool the server offers |
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
