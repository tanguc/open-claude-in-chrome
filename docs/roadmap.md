# Roadmap

Planned features, not yet built. They come from comparing this project with [agent-browser](https://github.com/ctate/agent-browser), a shell CLI for browser automation. Our strength is driving the user's real Chrome session with named workspaces. agent-browser covers cases we don't: scripts that call the browser without an LLM, isolated profiles, several independent browsers and headless runs.

The goal is to cover those cases without giving up the real-session default.

## 1. Shell CLI with JSON output

A `ocic` command that calls any browser tool from a shell:

```bash
ocic tabs_context_mcp --groupName ci --createIfEmpty true
ocic navigate --tabId 123 --url https://example.com
ocic read_page --tabId 123 --json
ocic screenshot --tabId 123 --out shot.png
```

This serves scripts, test harnesses and agents that have a shell but no MCP client.

Design notes:

- Reuse `host/tool-runtime.js` in-process (`init`, `callTool`, `shutdown`), the same way the MCP frontends do. The CLI is one more short-lived client of the host-owned bridge, so it needs no new transport.
- Build flags from the Zod schemas in `host/tool-definitions.js`, so the CLI can't drift from the MCP catalog. `coerceArgs` already handles string inputs.
- `--json` prints the raw result. Image content (screenshots, zoom) is written to `--out` instead of dumping base64 to stdout.
- Exit codes: 0 on success, 1 on a tool error, 2 when the bridge or extension is unreachable (with the `healthcheck` advice on stderr).
- There's no state between calls. Callers pass `tabId` and `groupName` explicitly, which matches the existing contract (no mutable current group).
- A dropped connection after dispatch must report an unknown outcome, like the runtime does today. The CLI must not retry actions automatically.
- Optional later: `ocic batch < steps.jsonl` to run several steps over one connection.

Open question: whether to ship it as `host/cli.js` with a `bin` entry, or as a separate package.

## 2. Isolated browser profiles

A launcher that starts a dedicated Chrome profile with its own bridge, so several independent browsers can run side by side and tests get a reproducible environment:

```bash
ocic-browser start --name fixture-a --window-size 1280x800
OCIC_PIPE=/tmp/ocic-fixture-a.sock ocic navigate ...
ocic-browser stop --name fixture-a
```

Design notes:

- Each instance gets its own `--user-data-dir` and its own `OCIC_PIPE`. `host/endpoint.js` already honors `OCIC_PIPE`; the host started by that browser has to see the same value. This has to be checked: Chrome passes its environment to the native host, but that isn't guaranteed across launchers.
- Native messaging manifests: with a custom `--user-data-dir`, Chrome is expected to look for them under `<user-data-dir>/NativeMessagingHosts/`. `install.sh` would need a mode that writes the manifest there. To verify on macOS and Linux.
- Extension ID: the manifest has no `key`, so the unpacked ID depends on the load path. Add a fixed `key` so every profile gets the same ID and one `allowed_origins` entry covers all of them.
- Loading the extension: branded Chrome 137+ ignores `--load-extension`. Options are to load it once by hand into a persistent profile, to use Chromium or Chrome for Testing, or to load it through CDP (`Extensions.loadUnpacked`, which needs `--remote-debugging-pipe` and `--enable-unsafe-extension-debugging`). Pick one after a spike.
- Fix window size and device scale factor at launch for screenshot tests.
- Short socket paths under `/tmp` (macOS limits unix socket paths to about 104 bytes).
- `stop` kills only the processes it started and removes the scratch profile unless `--keep` is passed.

The default stays the user's real Chrome. Isolated profiles are opt-in.

## 3. Headless and CI runs

Run the extension in headless Chrome on a machine with no user session, typically CI.

Design notes:

- Builds on feature 2: a fresh isolated profile, launched with `--headless=new`, which supports extensions.
- Requires Chromium or Chrome for Testing in CI (branded Chrome doesn't allow command-line extension loading).
- Unknowns that need a spike before any design work: whether native messaging works in headless mode, whether the MV3 service worker stays alive long enough for the host link, and how `chrome.debugger` behaves without a visible window.
- Humanized input, recording and audits are pointless here and should default to off in this mode, without changing the defaults for the real browser.
- A CI smoke test: start headless, `healthcheck`, open a local page, click, read back, stop.

## Order

The CLI comes first: it's the smallest piece and the other two need it for scripting and tests. Isolated profiles come next, then headless, which depends on them.
