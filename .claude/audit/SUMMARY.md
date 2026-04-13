# Audit Summary — open-claude-in-chrome

**Overall verdict:** CLEAN (safe to run) with ISSUES (correctness + hardening work recommended)

The malicious-code auditor found zero exfiltration, zero backdoors, zero privilege abuse, and a clean supply chain. The code is a faithful reimplementation of Claude in Chrome with the domain blocklist removed, exactly as advertised. Trust-level concerns: none. Quality/hardening concerns: several HIGH-severity code-quality defects worth fixing before wider distribution.

## Findings at a glance

| Tot | CRITICAL | HIGH | MEDIUM | LOW | INFO |
|---|---|---|---|---|---|
| **26** | 0 | 3 | 8 | 10 | 8 (incl. 5 positive signals) |

## Top findings (by severity)

| Sev | Title | Location | Report |
|---|---|---|---|
| HIGH | `upload_image` interpolates unsanitized `ref` into `Runtime.evaluate` (×2 call sites) | extension/background.js:851, 862 | EXTENSION |
| HIGH | `install.sh` does not validate extension ID before JSON/path interpolation | install.sh:29,62 | INSTALL |
| MEDIUM | `javascript_tool` has no output cap, timeout, or API allow-list | extension/background.js:727 | EXTENSION |
| MEDIUM | `content.js` message listener has no `sender.id` check | extension/content.js:419 | EXTENSION |
| MEDIUM | `window.__unblockedChrome` exposes internal API to any page script | extension/content.js:454 | EXTENSION |
| MEDIUM | No auth on TCP client channel (any local process can drive the extension) | host/mcp-server.js:162 | HOST |
| MEDIUM | No inbound message size cap in native-host (length header trusted) | host/native-host.js:32 | HOST |
| MEDIUM | No max buffer size on TCP channel (OOM on garbage peer) | host/mcp-server.js:220 | HOST |
| MEDIUM | `install.sh` uses `set -e` but not `-u` / `-o pipefail` | install.sh:2 | INSTALL |
| MEDIUM | `install.sh` omits Arc, Opera, Vivaldi despite README advertising them | install.sh:99 | INSTALL |
| LOW | Unused permissions: `activeTab`, `storage` | extension/manifest.json:10,16 | EXTENSION |
| LOW | `zod` imported but undeclared in `host/package.json` | host/package.json:7 | HOST |
| LOW | Missing `unhandledRejection` / `uncaughtException` / SIGPIPE handlers | host/*.js | HOST |
| LOW | Client reconnect loop after primary death has no max-retry limit | host/mcp-server.js:353 | HOST |

## Per-report status

- **[.claude/audit/MALICIOUS.md](./MALICIOUS.md)** — CLEAN. No malicious, deceptive, or backdoor code. TCP listeners bind only to 127.0.0.1. Supply chain is just `@modelcontextprotocol/sdk`; all transitive deps are legitimate npm packages, zero postinstall scripts.
- **[.claude/audit/EXTENSION.md](./EXTENSION.md)** — 2 HIGH / 3 MEDIUM / 4 LOW / 1 INFO. Core concern: `upload_image` string-interpolates `ref` into `Runtime.evaluate`, and `content.js` exposes internal helpers as `window.__unblockedChrome` in MAIN world, reachable by any page.
- **[.claude/audit/HOST.md](./HOST.md)** — 0 HIGH / 3 MEDIUM / 4 LOW / 2 INFO. Bind surface is 127.0.0.1 only (confirmed). Main gaps: no channel auth, no inbound size caps, transient dep `zod` not declared.
- **[.claude/audit/INSTALL.md](./INSTALL.md)** — 1 HIGH / 2 MEDIUM / 2 LOW / 2 INFO. No sudo, no network, no rc-file edits. Main gaps: no extension-ID validation, missing browser coverage (Arc/Opera/Vivaldi), no `-u`/`pipefail`. Native host name matches exactly between `install.sh` and `extension/background.js`.

## Recommended next actions

1. **Fix `upload_image` ref interpolation** (EXTENSION HIGH) — validate `ref` against `/^ref_\d+$/` or use `Runtime.callFunctionOn` with structured args instead of inline string concatenation. Same pattern appears at `background.js:851` and `:862`.
2. **Validate extension IDs in `install.sh`** (INSTALL HIGH) — require `^[a-z]{32}$` before interpolating into JSON or filesystem paths.
3. **Remove `window.__unblockedChrome` MAIN-world export** (EXTENSION MEDIUM) — the fallback injection path at `background.js:293` already re-injects `content.js`, making the global redundant.
4. **Add `sender.id` check to `content.js` message listener** (EXTENSION MEDIUM) — `if (sender.id !== chrome.runtime.id) return false;` at top of handler.
5. **Cap native-host inbound message size at 1 MB** (HOST MEDIUM) — `native-host.js:32`, match Chrome's protocol limit.
6. **Cap TCP buffer size** (HOST MEDIUM) — `mcp-server.js:220`, destroy socket if a peer exceeds e.g. 8 MB without a newline.
7. **Add `zod` to `host/package.json`** (HOST LOW) — currently relies on MCP SDK transitive.
8. **Drop `activeTab` and `storage` from `extension/manifest.json`** (EXTENSION LOW) — both are unused.
9. **Extend `install.sh` with Arc/Opera/Vivaldi** (INSTALL MEDIUM) OR update README to remove them from the advertised list.
10. **Harden `install.sh` shell options** (INSTALL MEDIUM) — `set -euo pipefail`.

No finding blocks trust; the HIGH items are all code-quality defects exploitable only by a caller that is already inside the local trust boundary (the Claude Code stdio session or another local process on the machine). Fix order above is "biggest hardening win first".
