# Design — Open Claude in Chrome

## What it is

A clean-room reimplementation of Anthropic's "Claude in Chrome" that exposes 18 browser-automation tools to Claude Code via MCP, with no domain blocklist and support for any Chromium-based browser. Claude sends a tool call, the extension drives a real Chromium tab via the Chrome DevTools Protocol, and the result comes back through the same pipe.

## High-level architecture

```
┌──────────────┐  stdio MCP   ┌──────────────┐  TCP loopback  ┌─────────────┐  native msg   ┌──────────────┐
│  Claude Code │ ───────────> │ mcp-server.js│ <────────────> │native-host.js│ <──────────> │   Extension   │
│   (client)   │ <─────────── │   (Node)     │    18765       │    (Node)    │  stdin/stdout│ (service worker)│
└──────────────┘              └──────────────┘                └─────────────┘               └──────┬───────┘
                                                                                                    │ chrome.debugger
                                                                                                    │   CDP 1.3
                                                                                                    ▼
                                                                                              ┌──────────┐
                                                                                              │  Chrome  │
                                                                                              │   tab    │
                                                                                              └──────────┘
```

Three independent processes, four hops. Each hop uses a protocol that is fundamentally required by the layer above — there is no layer you can just remove.

## The four hops, and why each exists

### 1. Claude Code ↔ mcp-server.js — stdio MCP

Claude Code launches `node host/mcp-server.js` as a subprocess. They speak the Model Context Protocol over stdin/stdout. This is the contract with Claude Code itself — MCP is how tool servers plug into Claude Code. The MCP server registers 18 tools (navigate, computer, javascript_tool, etc.) with their input schemas, and the SDK handles framing.

Why a separate process at all? Because the other end of the pipe — the browser extension — cannot be spawned by Claude Code directly. Chrome will only launch native messaging hosts on its own, from a manifest it owns. So we need a Node process that Claude Code *can* spawn, which then talks to a Node process Chrome *will* spawn.

### 2. mcp-server.js ↔ native-host.js — TCP on 127.0.0.1:18765

This is the bridge between the "Claude Code spawned me" process and the "Chrome spawned me" process. They can't share stdio (each has its own parent), so they rendezvous on a localhost TCP port. Messages are newline-delimited JSON.

The TCP channel also unlocks the **multi-session** story (see below).

### 3. native-host.js ↔ Extension — Chrome native messaging

Chrome launches `native-host.js` when the extension calls `chrome.runtime.connectNative("com.anthropic.open_claude_in_chrome")`. It uses Chrome's native messaging protocol: 4-byte little-endian length prefix, then JSON payload, over the host process's stdin/stdout (`native-host.js:32-47, 49-55`).

The host doesn't do anything interesting — it's a pure relay. Chrome stdin → decode length-prefixed JSON → TCP write. TCP read → split on newline → encode length-prefixed JSON → Chrome stdout.

### 4. Extension ↔ Chrome tab — chrome.debugger (CDP)

The service worker attaches to each target tab via `chrome.debugger.attach({ tabId }, "1.3")` (`extension/background.js:146-160`). From there it sends Chrome DevTools Protocol commands: `Page.captureScreenshot`, `Input.dispatchMouseEvent`, `Input.insertText`, `Runtime.evaluate`, `Page.navigate`, `Network.*`, `Console.*`.

This is what makes the extension feel "real": CDP gives you the same primitives that Puppeteer and Playwright use. Mouse clicks go through `Input.dispatchMouseEvent`, not synthetic DOM events, so sites that check for trusted events are fooled.

## Why it needs a native host at all

The native host looks redundant at first — just a pipe. The reason it exists is that Chrome extensions cannot open arbitrary TCP sockets and cannot run Node. They have `chrome.runtime.connectNative`, which spawns a trusted host binary and gives you a message port to it. That's the only way to break out of the extension sandbox into a place where Node (and therefore `net.createServer`) exists. The native host is the smallest possible bridge that does that.

## The tool layer (18 tools)

Each tool is a handler in `extension/background.js` under `toolHandlers`. The MCP server declares the schemas, forwards calls over TCP as `{ id, type: "tool_request", tool, args }`, and the extension dispatches to the handler. The handler's return value is sent back as `{ id, type: "tool_response", result }`.

Categories:

| Category | Tools | Primitive |
|---|---|---|
| Tab + group management | `tabs_context_mcp`, `tabs_create_mcp` | `chrome.tabs.*`, `chrome.tabGroups.*` |
| Navigation | `navigate` | `chrome.tabs.update`, goBack/goForward |
| Computer use | `computer` (13 actions: screenshot, click, type, key, scroll, drag, etc.) | CDP `Input.*`, `Page.captureScreenshot` |
| DOM inspection | `read_page`, `get_page_text`, `find` | content script walks the a11y tree, assigns refs |
| DOM interaction | `form_input`, `upload_image` | content script sets native setters; CDP file input injection |
| Code exec | `javascript_tool` | CDP `Runtime.evaluate` |
| Observability | `read_console_messages`, `read_network_requests` | CDP `Console.*` + `Network.*` event listeners |
| Window | `resize_window` | `chrome.windows.update` |
| Stubs | `gif_creator`, `shortcuts_*`, `switch_browser`, `update_plan` | no-ops for parity |

### Named tab groups as the authorization boundary

Claude doesn't get to drive any tab in the browser. The extension manages a `Map<groupName, { id, color, tabIds }>` of **named** tab groups, where each agent (or sub-agent, or sibling Claude session) owns its own group identified by a unique `groupName`. The first call an agent makes is always:

```
tabs_context_mcp({ groupName: "<unique-name>", createIfEmpty: true, color: "<color>" })
```

This is the only place a group can be created (`tabs_create_mcp` adds tabs to an existing named group). Every tool handler starts with `await isInOurGroup(tabId)` and refuses tabs that don't belong to *any* of our named groups. The authz is just: loopback + named-group membership. If the user drags a tab out of all our groups, it drops out of Claude's reach.

**Why named groups instead of one global group:** multiple agents can share one Chrome instance without colliding. Each picks its own `groupName`, gets its own colored group in the tab strip, and can only see/touch its own tabIds. An orchestrator can call `tabs_context_mcp()` with no arguments to inspect the full topology — which agents have which tabs.

**One host window.** All named groups live in a single Chrome window so the user sees them side-by-side in one tab strip, distinguishable by color. `ensureNamedGroup` reuses any existing window that already hosts one of our groups; only the very first creation spawns a new window. A global `creationMutex` serializes concurrent first-time bootstraps so two agents racing from an empty state can't both spawn a window.

**Persistence.** The map of named groups (just `name → { id, color }`, not the dynamic `tabIds`) is persisted to `chrome.storage.local` on every mutation. After a service-worker eviction or browser restart, `loadGroupsState()` reads the persisted set and verifies each entry against `chrome.tabGroups.get`, dropping any that have disappeared. An agent that disconnects can reconnect later with the same `groupName` and resume.

### Refs, not selectors

For DOM interaction, the content script walks the accessibility tree and assigns each element a ref like `ref_17`, keyed in an `elementMap` (`content.js`). Tools like `find`, `form_input`, `upload_image` operate on refs, not CSS selectors. `computer/click` can take a ref and internally calls `resolveRefToCoordinates` which asks the content script for the element's bounding-box center, then dispatches a real CDP `Input.dispatchMouseEvent` at those coordinates (`background.js:304-309, 353-375`).

Why refs: CSS selectors are brittle and get stale the moment the page rerenders. Accessibility-tree refs let Claude reason about "the Submit button" without having to generate fragile selectors, and the coordinate resolution happens at dispatch time so it survives reflows.

### Screenshots: fighting devicePixelRatio

Retina displays would normally hand back 2x-resolution screenshots, which blows up base64 size and — worse — desyncs screenshot pixel coordinates from the CSS-pixel coordinates used by `Input.dispatchMouseEvent`. The extension pins `deviceScaleFactor: 1` via `Emulation.setDeviceMetricsOverride` on attach (`background.js:150-159`). Screenshots come back in the same coordinate space as clicks, no scaling math needed. JPEG quality auto-drops from 55 to 30 if the base64 payload is over 500 KB (`:317-351`).

## Multi-session via primary/client multiplexing

One browser extension, many Claude Code sessions. Implemented entirely in `mcp-server.js`.

**Startup race.** Every new `mcp-server.js` instance tries to bind `127.0.0.1:18765`. First one wins → becomes **primary**. Subsequent instances get `EADDRINUSE` → become **clients** and `connect()` to the primary instead.

**Primary responsibilities** (`mcp-server.js:162-200`):
- Owns the TCP listener
- Accepts connections and **classifies** them with a 500ms grace period:
  - If the peer sends `{"type":"client_hello"}` within 500ms → it's a client MCP server
  - If it sends other data or nothing within 500ms → it's the native host (native hosts don't chat on connect)
  - This is a neat trick: no protocol version negotiation needed, just behavioral sniffing
- Keeps one `nativeHostSocket` and a `Map<clientId, socket>` of connected client servers
- When a client forwards a tool request, the primary prefixes the ID (so IDs don't collide across clients) and tracks the mapping in `clientRequestMap` for routing responses back to the right client

**Client responsibilities** (`mcp-server.js:297-363`):
- Sends `client_hello` immediately on connect
- Forwards its own Claude Code's MCP tool calls over the TCP socket to the primary
- On primary death: retries `connect()` every 2 seconds (forever, per the audit finding)

**Pidfile hygiene** (`:88-101`). Primary writes `/tmp/open-claude-in-chrome-mcp-18765.pid` at startup and removes it at shutdown. If a new server finds a stale pidfile, it checks whether the PID is alive before deciding to take over or yield. Recent commits (`414fc5b`, `de0c181`) fixed a bug where `lsof`-based cleanup killed orphans that weren't actually stale.

## Lifecycle and keep-alive

**Service worker eviction.** MV3 service workers get killed aggressively. The extension uses two tricks to stay alive:

1. **Keep-alive alarm** every 24 seconds (`extension/background.js:20-26`). `chrome.alarms` fires even when the worker is evicted, which wakes it back up. On wake, if `nativePort` is null, it reconnects.
2. **State recovery from `chrome.storage.local`.** In-memory `groupsByName` goes away on eviction. `loadGroupsState()` runs at boot, reads the persisted `{ groups: { name: { id, color } } }` map, and verifies each entry against `chrome.tabGroups.get`. `isInOurGroup` always cross-checks `chrome.tabs.get` to handle the window between worker start and storage-load completion.

**Native port lifecycle.** `connectNativeHost` registers `onDisconnect` and retries in 2 seconds, so a `native-host.js` crash heals itself.

**Native host timeout.** If the TCP connection to `mcp-server.js` fails 60 times in a row (30 seconds), the native host exits cleanly instead of lingering as a zombie (`native-host.js:101-114`).

**Chrome debugger lifetime.** `chrome.debugger.attach` persists until the user clicks "dismiss" on the debugger bar or the tab closes. The extension handles both cases (`background.js:176-189`), clearing its `attachedTabs` state so the next tool call re-attaches lazily.

## The coordinate-space invariant

This is the subtle thing that makes `computer` actually work. Three coordinate systems have to agree:

1. Screenshot pixels returned by `Page.captureScreenshot`
2. `x,y` arguments expected by `Input.dispatchMouseEvent`
3. Element bounding-box coordinates returned by `getBoundingClientRect()` in the content script

CDP uses CSS pixels for `Input.*` but *physical* pixels for `Page.captureScreenshot` by default. The `Emulation.setDeviceMetricsOverride` with `deviceScaleFactor: 1` collapses them into one. Without it, every click on a Retina display lands at half the intended location. The comment on line 150-151 is the whole reason this works at all.

## Threat model (as designed)

- **Trust root:** the local Claude Code process. Anything that can write to the MCP server's stdin is trusted to drive the extension.
- **Isolation:** loopback-only TCP (127.0.0.1), tab-group gate in every handler, no cross-origin network calls from the extension itself.
- **Not defended:** other local processes on the same machine (no auth on the TCP channel), the `javascript_tool` capability (it's by design: full page-origin JS is the advertised feature).
- **What the audit flagged** as hardening work (not trust breaks): string interpolation of `ref` into `Runtime.evaluate` in `upload_image`, no message size caps on the native host, unused manifest permissions. See `.claude/audit/SUMMARY.md`.

## Why this design over alternatives

| Alternative | Why it wasn't taken |
|---|---|
| Puppeteer / Playwright with headless Chrome | Requires a managed browser process; can't reuse the user's existing Chrome session, bookmarks, logins |
| `--remote-debugging-port` on user's Chrome | Chrome refuses to expose CDP over a remote debugging port to arbitrary clients without special flags the user rarely runs; CORS and origin checks block it |
| WebSocket server inside the extension | MV3 service workers can't listen; they can only make outbound connections. And even then, only to origins listed in `host_permissions` |
| DevTools panel UI | Requires the user to keep DevTools open; not invisible automation |

The native-messaging-host bridge is the only path that lets a stock Chrome extension (no flags, no policy) receive commands from a local non-browser process like Claude Code.
