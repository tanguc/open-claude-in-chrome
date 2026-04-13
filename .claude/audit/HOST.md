# Host Audit (MCP server + native host)

## Summary

Both files are well-structured with no shell injection, no 0.0.0.0 exposure, and clean
stdio hygiene. The main correctness gaps are: missing no-auth guard on the client TCP
multiplex channel (any local process can inject tool requests), no inbound message size
cap in the native-host, and the client reconnect loop after primary death has no
backoff or limit, causing indefinite reconnection attempts. `zod` is an undeclared
dependency (used but absent from package.json), resolved transitively via the MCP SDK.

## Bind surface

| Listener | Address | Port | Auth | Verdict |
|---|---|---|---|---|
| tcpServer (mcp-server.js) | 127.0.0.1 | 18765 (configurable) | None — localhost-only | OK: loopback only |
| primarySocket client (mcp-server.js) | 127.0.0.1 | same | client_hello handshake | OK: loopback only |
| tcpSocket (native-host.js) | 127.0.0.1 | same | none needed (client) | OK |

No 0.0.0.0 binding anywhere. Port is configurable via `~/.config/open-claude-in-chrome/config.json`.

## Findings

- **MEDIUM** No authentication on TCP client channel — mcp-server.js:162
  - What: Any local process can connect to 127.0.0.1:18765, send `{"type":"client_hello"}`,
    and have tool requests forwarded to the browser extension on its behalf. The only gate
    is loopback; there is no token or shared secret.
  - Impact: Other local processes (malicious apps, other users on multi-user systems) can
    drive the extension silently. On a single-user desktop this is low-friction to exploit
    but requires local code execution already.
  - Fix: Generate a random nonce at startup (or read from a mode-600 file in $TMPDIR),
    require it in client_hello, reject connections that omit it.

- **MEDIUM** No inbound message size cap in native-host — native-host.js:32-47
  - What: `readNativeMessage` reads `len` directly from the 4-byte LE header with no upper
    bound check. Chrome's native messaging limit is 1 MB inbound, but the host does not
    enforce this; a rogue browser-side sender could issue a header declaring a multi-GB
    message, causing the Node process to allocate that buffer.
  - Impact: Extension compromise or a bug in the extension could OOM the native host.
  - Fix: Add `if (len > 1024 * 1024) { process.exit(1); }` after reading the header.

- **MEDIUM** No inbound message size cap on TCP channel — mcp-server.js:220-227, 264-266
  - What: Newline-delimited JSON is accumulated in `buffer` with no max-buffer size. A
    connected peer (native host or client MCP server) sending a single line without a
    newline — or a very long line — grows the buffer unboundedly.
  - Impact: Memory exhaustion / OOM if a peer sends garbage or a very large payload.
  - Fix: Enforce a per-buffer max (e.g., 8 MB); destroy the socket if exceeded.

- **LOW** Client reconnect after primary death is unbounded — mcp-server.js:353-363
  - What: When the primary disconnects, the client calls `setTimeout(connect, 2000)` on
    every close event. There is no attempt counter or maximum retry limit, so a client
    that can never reach a new primary retries forever.
  - Impact: Zombie clients accumulating reconnect timers; no meaningful resource leak on a
    normal desktop but can mask misconfiguration.
  - Fix: Add a max-attempts counter mirroring the native-host pattern (MAX_RECONNECT_ATTEMPTS).

- **LOW** `zod` undeclared in package.json — host/package.json:7
  - What: `mcp-server.js` imports `zod` directly (`import { z } from "zod"`), but `zod` is
    not listed in `dependencies`. It resolves only because `@modelcontextprotocol/sdk`
    depends on it transitively.
  - Impact: A future SDK version that removes or internalises `zod` would break the server
    silently. Technically a missing direct dependency declaration.
  - Fix: Add `"zod": "^3.x"` to `host/package.json` dependencies.

- **LOW** No `unhandledRejection` / `uncaughtException` handlers — mcp-server.js, native-host.js
  - What: Neither file registers `process.on('uncaughtException')` or
    `process.on('unhandledRejection')`. Unhandled promise rejections (e.g., from the MCP
    SDK transport) will print to stderr but crash the process in Node 15+.
  - Impact: An unexpected SDK error kills the MCP server mid-session.
  - Fix: Add minimal handlers that log to stderr and optionally call shutdown().

- **LOW** No SIGPIPE handler — mcp-server.js, native-host.js
  - What: Neither file handles SIGPIPE. On Linux/macOS, writing to a closed pipe (e.g.,
    after Claude Code closes stdin) raises SIGPIPE, which by default terminates the process
    immediately, bypassing any cleanup.
  - Impact: Pidfile left behind if process is killed via SIGPIPE before cleanup runs.
    native-host.js:134 handles stdin 'end' but not the signal itself.
  - Fix: `process.on('SIGPIPE', () => {})` — Node usually ignores it but explicit is safer.

- **INFO** Config file parsed without schema validation — mcp-server.js:24-31, native-host.js:15-28
  - What: `config.port` is used directly as a number with `|| DEFAULT_PORT` fallback but
    no range/type check. A config with `"port": "evil"` would produce `NaN`, causing
    `listen(NaN, ...)` to silently fail in some Node versions.
  - Fix: `const p = Number(config.port); return (Number.isInteger(p) && p > 0 && p < 65536) ? p : DEFAULT_PORT;`

- **INFO** Stale client request map entries on client disconnect — mcp-server.js:297-304
  - What: On client socket close, the code iterates `clientRequestMap` and deletes entries
    belonging to that client. However, if the native host responds to a prefixed ID after
    the client has disconnected, `handleResponse` at line 129 will find `clientRequestMap`
    has no entry for that ID and silently drop the response — no timeout is cleared.
    The paired 60s timer in the primary's own `pendingRequests` is also not cleared.
  - Impact: Timer leaks in the primary for requests from disconnected clients.
  - Fix: When cleaning up a client's entries in clientRequestMap, also cancel the
    corresponding entry in the primary's `pendingRequests` if one was created for it
    (or track timers per client).

## Protocol framing

**Native messaging (native-host.js):** Correct 4-byte LE prefix read/write using
`readUInt32LE`/`writeUInt32LE`. Partial-read accumulation via `stdinBuffer` is correct.
No maximum message size enforcement (see MEDIUM finding above). Outbound
`writeNativeMessage` correctly encodes to UTF-8 before measuring byte length.

**MCP framing (mcp-server.js):** Uses `@modelcontextprotocol/sdk` StdioServerTransport
which handles framing internally. The host code has no direct `process.stdout.write`
calls (only the SDK writes to stdout). All logging goes to `process.stderr.write`. TCP
channel uses newline-delimited JSON with correct incremental buffer accumulation.

## Lifecycle / multi-session

Primary/client logic is sound: first server to win the port becomes primary, subsequent
ones connect as clients. EADDRINUSE falls through to client mode cleanly. Pidfile logic
correctly avoids killing a live primary (only removes stale files for dead PIDs). The
500ms classify timeout for native host vs client is adequate for loopback. One gap: when
a client session ends, there is no notification path back to pending timers for forwarded
requests (see INFO finding above). Re-election when the primary dies is not implemented
— clients retry indefinitely waiting for a new primary to appear; this is by design but
should have a limit.

## Dependencies

| Package | Version | Source | Notes |
|---|---|---|---|
| @modelcontextprotocol/sdk | 1.29.0 | npmjs.org | sole declared dep; brings zod, express, hono, jose as transitive |
| zod | 3.x (transitive) | npmjs.org | used directly, not declared — LOW finding |
| express / hono / jose / cors | various | npmjs.org | SDK transitive only, not used by host code directly |
| All others | various | npmjs.org | all resolved from registry.npmjs.org with sha512 integrity |

No non-npm URLs, no git/file/http dependencies, no postinstall/install scripts anywhere
in the lockfile. No typosquats detected. Package tree is well-known ecosystem packages.

## What I checked

- Read mcp-server.js (699 lines) and native-host.js (141 lines) in full
- Grepped for: `listen(`, `127.0.0.1`, `0.0.0.0`, `console.log`, `process.stdout.write`,
  `process.stderr`, `spawn`, `exec`, `require(`, `unhandledRejection`, `uncaughtException`,
  `SIGPIPE`
- Traced MCP tool call -> sendToExtension -> TCP write -> native-host stdin -> extension,
  and reply path back through handleResponse
- Inspected all `net.createServer` / `net.createConnection` bind addresses
- Checked package.json declared deps vs actual imports
- Parsed package-lock.json for non-npm resolved URLs, lifecycle scripts, and typosquats
- Verified all logging goes to stderr in mcp-server.js (no stdout pollution)
- Checked native-host.js writes to stdout only via writeNativeMessage (correct)
