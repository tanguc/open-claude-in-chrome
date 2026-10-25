# Browser bridge design

## Runtime ownership

```
MCP frontend -> tool-runtime.js -> local pipe -> native-host.js -> native messaging -> extension -> CDP/content script
```

The browser starts the native host through `connectNative`. The host owns the bridge and multiplexes connected MCP clients. A Claude Code session no longer binds a TCP port, classifies peers or elects a primary. Ending one session leaves the others connected.

`host/endpoint.js` selects `/tmp/open-claude-in-chrome-<uid>/bridge.sock` on macOS/Linux, or a named pipe on Windows. The POSIX path is independent of `TMPDIR`: browser launchers and MCP transports do not necessarily inherit the same environment. Its 0700 directory must be owned by the current user and must not be a symlink; unsafe collisions fail closed before permission changes. Socket permissions are 0600.

`OCIC_PIPE` overrides the rendezvous for isolated tests; the `pipe` setting in the per-user config overrides the default for an installation. Explicit overrides do not create or modify the default directory. Both sides must resolve the same endpoint.

The wire protocol is newline-delimited JSON between runtime and host. Browser native messaging uses a four-byte little-endian length prefix followed by JSON. The host namespaces request IDs per client and routes responses back to their origin. A dropped connection after dispatch leaves an unknown result: the runtime asks the caller to inspect page state instead of automatically replaying an action.

## Shared frontends

`host/tool-definitions.js` holds Zod 4 schemas used by the standard, hybrid and codemode servers. Native `z.toJSONSchema` emits Draft 7 input schemas with inline reuse and rejects cycles or unrepresentable types instead of weakening them. The TypeScript description generator handles primitive type arrays and real null. All 28 exported schemas are compared with the actual stdio MCP catalog in tests.

`host/tool-runtime.js` manages the client connection, argument coercion, pending calls and recording events. Frontends use it in-process, not through a child stdio MCP server.

The standard frontend exposes individual browser tools. Hybrid adds `execute_code` and recording channels. Codemode exposes the sandbox interface. The latter two launch a local workerd sidecar through Wrangler; browser tool callbacks return to the same runtime over a local HTTP proxy. Starting that sidecar is separate from testing the direct tools.

`host/parent-watch.js` watches the frontend's parent and activity. The native host watches extension traffic. Their lifecycle suites exercise real child processes without using a browser.

## Named workspaces

`extension/groups.js` stores a map from group name to Chrome group ID, color and tab IDs. Each new name creates a dedicated window with one blank tab. The window is not raised and subsequent tabs are not selected. Concurrent creation is locked per name, so different agents can bootstrap independently without creating duplicate windows for one name.

The map persists under the existing `groups` key in `chrome.storage.local`. Recovery checks actual Chrome groups and tabs, and can resolve a persisted name after a Chrome group ID changes. Tab membership is checked against live browser state before dispatch; an in-memory tab ID does not retain access after the tab leaves the group. Closing the final tab removes that group's persisted entry.

The public contract is:

```javascript
tabs_context_mcp({ groupName: "research", createIfEmpty: true, color: "green" })
tabs_create_mcp({ groupName: "research" })
close_tabs({ groupName: "research" })
```

`tabs_context_mcp({})` lists all managed groups without creating one. Creation requires an explicit name. Each handler keeps the requested group's metadata locally; there is no mutable global current group that concurrent calls can overwrite.

`close_tabs` accepts either a group name or an array of tab IDs. It validates the whole array before closing any tab. An absent named group is a no-op. The upstream `tabs_close_mcp` API remains available for individual/batch IDs and skips unmanaged IDs.

Names coordinate agents but do not authenticate them. Membership in any managed group permits dispatch, as in the previous fork. Callers must use only their own tab IDs; this is not a security boundary between mutually untrusted sessions.

## Browser tools and recording

The extension is an MV3 module service worker. It uses `chrome.debugger` for CDP input, screenshots, navigation and observation. The content script supplies accessibility references and DOM operations. Input planners, click-target diagnostics, file upload, resize handling and debug traces come from the upstream implementation.

Imitation-learning recording captures browser actions and optional narration. The offscreen recorder and options page handle capture and review; transcription requires a separately configured external API key. Session auditing is a separate opt-in configuration using rrweb and the native host for persistence. These paths can handle sensitive browser data and must not be enabled or shared without authorization.

No API key is needed for the direct browser tools or the offline test suites.

## Healthcheck

The shared runtime handles `healthcheck` with a five-second probe to the extension. It reports its process ID, client mode, transport and endpoint, current connection state, pending count, extension state and diagnostic advice. The extension supplies its version, named groups and attached tabs.

A failed probe returns diagnostic JSON rather than a generic tool error. Diagnostics reflect the host-owned local pipe, not obsolete primary/client TCP election fields.

## Installation on internal storage

On macOS, `install.sh` installs `native-host.js`, `endpoint.js`, package metadata and a wrapper under `~/Library/Application Support/open-claude-in-chrome/`. Linux uses `~/.local/share/open-claude-in-chrome/`. Browser manifests point at that installed wrapper. Windows retains the upstream batch-wrapper and per-user registry installation.

The internal copy avoids macOS TCC failures when the repository is on removable storage. The new host imports a sibling ESM module, so copying only `native-host.js` is insufficient: `endpoint.js` and the package's `type: module` must accompany it. The repository remains the source of truth. Re-run the installer after changing an installed file, then restart the browser at an agreed time.

## Verification and limits

Run `npm test --prefix host` after installing host dependencies. `test/run.mjs` discovers extension and host suites, isolates HOME and temporary paths, stops at the first failing suite and removes its scratch state. Tests cover the upstream planners/handlers, endpoint and ownership lifecycles, named-group concurrency/persistence, both cleanup interfaces, healthcheck, a real stdio MCP handshake and an isolated POSIX installation/host launch.

These tests are not a fresh security audit and do not establish live browser parity. They do not exercise Windows registry writes, real CDP actions, microphone capture, external transcription or the codemode sandbox. Existing historical audit reports predate this architecture and must not be treated as current findings without verification.

The imported upstream history is source-available under PolyForm Noncommercial 1.0.0. See `LICENSE`; third-party notices remain with their components.
