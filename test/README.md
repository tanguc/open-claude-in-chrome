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

Fork regression suites cover named-group concurrency and persistence, immediate revocation after a tab leaves a group, both cleanup APIs, pipe-based healthcheck, the actual stdio MCP handshake, and installation of all native-host ESM files into an isolated internal location. The existing host suites exercise endpoint selection, parent lifecycle and multi-client ownership through real child processes. Endpoint regressions also check that browser and filtered MCP environments meet on the same socket. Security cases verify directory ownership, symlink rejection, 0700/0600 modes and isolation of explicit test pipes.

These gates do not validate live browser/CDP behavior, Windows registry installation, microphone capture, external transcription or execution in the codemode worker.

`_extract.mjs` pulls the functions under test out of `extension/background.js` by
brace-matching. That indirection is deliberate: `background.js` is a service
worker with no exports whose top level touches `chrome.*` immediately, so this
lets the tests exercise the shipped source instead of a copy that could drift.

## Configuration and schema regressions

`default-config.test.mjs` tests the shipped configuration section and planner: humanization is enabled at natural speed on a fresh profile, after partial storage changes and after a reset. Explicit stored global and per-tab choices remain authoritative. Auditing stays off by default.

`host/test/schemas.test.mjs` checks all 28 tool contracts captured before the Zod 4 migration, validates the generated JSON Schemas, exercises required fields and constraints, and checks codemode/hybrid TypeScript input types. The stdio MCP test compares every schema actually advertised by the server with the shared exported catalog.

## Dependency audit

The host uses Zod 4.6.7 or later and native `z.toJSONSchema` conversion in Draft 7 input mode. The application's direct `zod-to-json-schema` dependency is removed; the MCP SDK still carries that package transitively for its legacy compatibility path.

On 2026-10-25, `npm audit --prefix host --omit=dev` reports zero known vulnerabilities, including resolution of [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5). This result applies to the host dependency tree, not to a full code audit or the separate codemode worker dependency tree.
