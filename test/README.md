# Tests

Run the extension and host suites from the repository root:

```bash
npm ci --prefix host --ignore-scripts
npm test --prefix host
```

`run.mjs` executes every `*.test.mjs` under `test/` and `host/test/` with an isolated HOME and temporary directory, then removes that scratch state. It stops on the first failure. The tests do not require a browser, a transcription key or the codemode worker.

| File | Covers |
|---|---|
| `humanize-planners.test.mjs` | The pure planners in `extension/humanize/`. Asserts the invariants that make humanization safe: a click always lands exactly on its target (including 8×8px targets), typed text reassembles byte-identically (incl. unicode/emoji), scroll deltas sum to exactly the requested amount, key hold stays below the OS typematic initial delay, and a deliberate long hold renders the real auto-repeat sequence. |
| `humanize-executor.test.mjs` | The plan→CDP seam: runs the shipped `dispatchPlan` against a mock CDP layer and asserts the exact calls, their order (`keydown → insertText → keyup` per character), and per-tab cursor continuity. This is the layer that caught the missing shifted-digit key mappings. |
| `handlers.test.mjs` | Tool handlers against a mocked `chrome.*` API: that creating a tab never selects it or raises a window (#28), that `set_tab_focus` is quiet unless `focus_window` is set (#35), and the layered default/per-tab config with its storage scoping. |

Fork regression suites cover named-group concurrency and persistence, immediate revocation after a tab leaves a group, both cleanup APIs, pipe-based healthcheck, the actual stdio MCP handshake, and installation of all native-host ESM files into an isolated internal location. The existing host suites exercise endpoint selection, parent lifecycle and multi-client ownership through real child processes.

These gates do not validate live browser/CDP behavior, Windows registry installation, microphone capture, external transcription or execution in the codemode worker.

`_extract.mjs` pulls the functions under test out of `extension/background.js` by
brace-matching. That indirection is deliberate: `background.js` is a service
worker with no exports whose top level touches `chrome.*` immediately, so this
lets the tests exercise the shipped source instead of a copy that could drift.

## Dependency audit

The host lockfile retains Zod 3 for compatibility with `zod-to-json-schema`. As of 2026-10-24, `npm audit --prefix host --omit=dev` reports one high-severity advisory, [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5). npm proposes Zod 4.6.7, a major migration that needs schema-conversion tests before adoption. The other nine alerts inherited from the upstream host lockfile were fixed with compatible updates; passing tests do not mean the dependency audit is clean.
