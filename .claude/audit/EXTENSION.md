# Extension Audit

## Summary

The extension is a well-structured MV3 browser automation tool that routes MCP tool calls from a native host through CDP. Permissions are broad but mostly justified by the automation surface. The primary concerns are: all tools gate access only by tab group membership (not any auth), `javascript_tool` executes arbitrary JS in any grouped tab with no additional restriction, and `upload_image` constructs CDP `Runtime.evaluate` expressions using unsanitized string interpolation of MCP-supplied `ref` values.

## Permissions review

| Permission | Used for | Verdict |
|---|---|---|
| tabs | Tab query, create, update, grouping, navigation | Justified |
| debugger | CDP attach/detach, all CDP commands | Justified — core to the tool |
| activeTab | Not directly referenced in background.js | Potentially unused; `tabs` + `host_permissions` already cover all tab access |
| scripting | `chrome.scripting.executeScript` fallback injection of content.js | Justified |
| nativeMessaging | `chrome.runtime.connectNative` to native host | Justified |
| tabGroups | Tab group create/query/update | Justified |
| windows | Window create/resize | Justified |
| storage | Imported in manifest; zero calls to `chrome.storage.*` in background.js | Unused — remove |
| alarms | Keep-alive alarm every 24 s | Justified |
| `<all_urls>` host_permissions | Content script injection on all pages, CDP attach to any tab | Broad but required for the stated automation purpose |

## Findings

- **HIGH** `upload_image`: unsanitized `ref` interpolated into CDP expression — background.js:851-868
  - What: `ref` from MCP args is string-interpolated directly into a `Runtime.evaluate` expression: `` `window.__unblockedChrome?.resolveRef?.("${ref}")` ``. A `ref` value containing `")` followed by arbitrary JS will execute in the tab's page context.
  - Impact: MCP client (or compromised native host) can run arbitrary JS in any grouped tab via `upload_image`, bypassing the `javascript_tool` intent boundary.
  - Suggested fix: validate `ref` matches `/^ref_\d+$/` before interpolation; or pass `ref` as a CDP `Runtime.callFunctionOn` argument, not inline text.

- **HIGH** `upload_image`: second `Runtime.evaluate` at background.js:862-870 has the same interpolation issue with `ref`.
  - (Same root cause as above — two separate expression strings both interpolate `ref`.)

- **MEDIUM** `javascript_tool`: no sandbox or allow-list — background.js:727-753
  - What: `args.text` is passed verbatim to `Runtime.evaluate` in any grouped tab. There is no output size limit, no timeout beyond the CDP default, and no restriction on which JS APIs are called (fetch, WebSocket, localStorage, etc.).
  - Impact: MCP client can exfiltrate page data, set cookies, initiate network requests, or exhaust memory. This is by design for an automation tool, but there is zero additional guardrail beyond the tab-group gate.
  - Suggested fix: enforce an output size cap on `result.result` before returning; document that `javascript_tool` is equivalent to full page-origin code execution.

- **MEDIUM** No origin/sender validation on content.js message listener — content.js:419-451
  - What: `chrome.runtime.onMessage.addListener` accepts all messages without checking `sender.id` or `sender.origin`. Any extension or page script that can send a runtime message to this extension's content script can call `setFormValue`, `findElements`, etc.
  - Impact: A malicious extension or (in limited scenarios) a page-injected script could manipulate form values or enumerate DOM refs in any page the extension is loaded on.
  - Suggested fix: add `if (sender.id !== chrome.runtime.id) return false;` at the top of the listener.

- **MEDIUM** `window.__unblockedChrome` exposes internal API to the page — content.js:454-462
  - What: The IIFE explicitly writes `resolveRef`, `elementMap`, `setFormValue`, `findElements`, `generateAccessibilityTree`, and `getPageText` onto `window` (MAIN world). Any JS running on the page can call these.
  - Impact: A malicious page can read all ref-mapped DOM elements, call `setFormValue` to silently fill form fields (including password fields), or enumerate the accessibility tree.
  - Suggested fix: Remove the `window.__unblockedChrome` export. The comment says "for executeScript fallback" but `sendContentMessage` already has a fallback injection path (background.js:293-300) that re-injects `content.js` — making the global export redundant.

- **LOW** `activeTab` permission is unused — manifest.json:10
  - What: `activeTab` is declared but no code calls `chrome.tabs.captureVisibleTab` or any API that requires it (all tab access uses the broader `tabs` + `<all_urls>` permissions).
  - Impact: Minimal attack surface increase, but violates least-privilege.
  - Suggested fix: Remove `activeTab` from the permissions array.

- **LOW** `storage` permission is unused — manifest.json:16
  - What: No calls to `chrome.storage.*` appear anywhere in background.js or content.js.
  - Impact: Unused permission; minor surface expansion.
  - Suggested fix: Remove `storage` from the permissions array.

- **LOW** No CSP override in manifest — manifest.json (absent)
  - What: No `content_security_policy` key is set. MV3 defaults apply (`script-src 'self'`), which is fine, but it is worth noting no explicit hardening is in place.
  - Impact: Default MV3 CSP is already restrictive; no immediate risk. Info only.
  - Suggested fix: Explicit CSP declaration documents intent and prevents accidental weakening if a key is added later.

- **LOW** Tab-group guard is the sole authz boundary — background.js:407, 457, 651, 677, 699, 716, 729, etc.
  - What: Every tool handler checks `isInGroup(tabId)` and refuses to operate on out-of-group tabs, but there is no authentication or signing on the native messaging channel itself. Anyone who can send messages to the native host can control the extension.
  - Impact: Lateral movement within the browser is bounded; but the native host process is the only trust root and its security is out of scope for this audit.
  - Suggested fix: Document the trust model explicitly; consider adding a shared secret or socket token to the native host protocol.

- **INFO** `read_console_messages` regex input from MCP — background.js:771-775
  - What: `args.pattern` is passed to `new RegExp(pattern, "i")`. A catastrophic (ReDoS) pattern would block the service worker event loop until the regex engine times out or Chrome kills it.
  - Impact: DoS of the service worker (tabs become unresponsive to MCP commands) until the alarm restarts the connection.
  - Suggested fix: Wrap regex construction with a length limit and a try/catch (already present for syntax errors) and add a character count guard (`pattern.length < 200`).

## Tool surface

| Tool | Input reaching CDP/DOM | Risk |
|---|---|---|
| `javascript_tool` | `args.text` → `Runtime.evaluate` verbatim | Full page-origin JS execution; intended by design |
| `upload_image` | `args.ref` interpolated into two `Runtime.evaluate` strings | JS injection via `ref` (HIGH) |
| `computer/type` | `args.text` → `Input.insertText` char-by-char | Safe; no expression eval |
| `computer/key` | `args.text` → `Input.dispatchKeyEvent` | Safe; key name parsed through KEY_MAP |
| `form_input` | `args.ref`, `args.value` → content script `setFormValue` | `ref` is a lookup key (safe); `value` is set via native setter, not eval |
| `find` | `args.query` → content script substring search | Safe; never reaches DOM as HTML |
| `read_page` | `args.filter`, `args.depth`, `args.max_chars`, `args.ref_id` → content script | `ref_id` used as lookup key only; options are primitives |
| `navigate` | `args.url` → `chrome.tabs.update` after URL validation | Validated with `new URL()`; `chrome:` and `about:` allowed explicitly |
| `read_console_messages` | `args.pattern` → `new RegExp` | ReDoS risk (INFO) |

## What I checked

- Read manifest.json in full; cross-checked each permission against background.js and content.js
- Read background.js lines 0-938 in three passes; mapped all tool handlers, CDP call sites, and native port lifecycle
- Read content.js lines 1-463 in full; checked message listener, DOM manipulation methods, and global exports
- Verified `chrome.storage` is absent from both JS files
- Verified `activeTab` has no usage in the codebase
- Traced `upload_image` ref interpolation through both `Runtime.evaluate` call sites
- Checked `window.__unblockedChrome` exposure scope (MAIN world, all pages)
- Checked message listener sender validation (absent)
- Checked navigate URL validation path (present and correct)
- Checked `computer/type` and `key` for injection (safe — uses CDP input APIs, not eval)
