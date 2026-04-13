# Malicious Code Audit

**Verdict:** CLEAN

## Summary

No malicious, deceptive, or backdoor code found. All network communication is strictly localhost (127.0.0.1:18765 TCP), all control flows only through the documented extension → native-host → MCP-server path, and the installer makes no privilege escalations or persistence changes beyond the standard NativeMessagingHosts directories. The code is a faithful open-source reimplementation of the Claude-in-Chrome browser automation tool with the domain blocklist removed, exactly as advertised.

## Findings

- **[INFO]** TCP server binds only on 127.0.0.1 — host/mcp-server.js:405
  - What: `tcpServer.listen(TCP_PORT, "127.0.0.1", ...)` — port 18765 by default, configurable via ~/.config/open-claude-in-chrome/config.json
  - Why noted: positive signal confirming no remote exposure

- **[INFO]** Native host connects only to 127.0.0.1 — host/native-host.js:71
  - What: `tcpSocket.connect(TCP_PORT, "127.0.0.1", ...)` — hardcoded localhost, no DNS lookup

- **[INFO]** No outbound fetch/XHR/WebSocket/sendBeacon in any file
  - What: grep across all .js and .sh files found zero network calls originating from extension code itself; the only URL construction is `"https://" + targetUrl` in background.js:419, which is user-supplied navigation, not exfiltration

- **[INFO]** install.sh: no sudo, no curl|bash, no shell rc edits — install.sh:99-121
  - What: writes only to `$HOME/Library/Application Support/.../NativeMessagingHosts/` (macOS) or `$HOME/.config/.../NativeMessagingHosts/` (Linux); creates one wrapper shell script in the repo's own host/ dir

- **[MEDIUM]** javascript_tool executes arbitrary JS in page context — background.js:732-752
  - What: `cdp(tabId, "Runtime.evaluate", { expression: text })` — runs whatever JS string Claude passes
  - Why suspicious: this is a deliberate feature (tool #9), not a backdoor. The expression comes from the Claude Code session over stdio MCP, which is the intended trust boundary. No external party can inject expressions here. Noted as MEDIUM only because any JS execution deserves mention; it is consistent with the advertised capability.
  - Evidence: `const result = await cdp(tabId, "Runtime.evaluate", { expression: text, returnByValue: true, awaitPromise: true });`
  - Confidence: low (expected feature, not malicious)

- **[LOW]** manifest.json: `"debugger"` permission + `<all_urls>` host permission
  - What: `debugger` enables CDP on any tab; `<all_urls>` lets content script run everywhere
  - Why suspicious: broad but justified — browser automation requires attaching the debugger to arbitrary user-chosen tabs; the domain blocklist removal is the entire stated purpose of this fork
  - Evidence: manifest.json lines 9, 19
  - Confidence: low (fully justified by feature set)

- **[LOW]** upload_image embeds a ref string in a Runtime.evaluate expression — background.js:851-857
  - What: `expression: \`window.__unblockedChrome?.resolveRef?.("${ref}")\`` — ref is a string like "ref_1" from the tool call args
  - Why suspicious: if an adversary could inject a crafted ref string with `"` chars they could break out of the string literal. However, the ref originates from the Claude Code MCP session (local stdio), not from page content. No untrusted input reaches this code path.
  - Evidence: `` expression: `(() => { const el = window.__unblockedChrome?.resolveRef?.("${ref}");` ``
  - Confidence: low (the injection surface is trusted; code quality issue, not malice)

## What I checked

- **Exfiltration**: grep for fetch, XMLHttpRequest, sendBeacon, WebSocket, EventSource, all http[s]:// literals across all .js and .sh files — no hits outside of user-directed navigation
- **Code execution**: eval, new Function, child_process, exec, spawn — none found; Runtime.evaluate is the documented javascript_tool feature
- **Credential/secret harvesting**: cookie, localStorage, password, keychain, .ssh, .aws, .env, IndexedDB, clipboard — zero hits across all files
- **Obfuscation**: atob, fromCharCode, \\x escapes, long base64 blobs — only base64 found in screenshot data handling (expected)
- **Persistence mechanisms**: launchctl, crontab, LaunchAgents, systemd, .bashrc, .zshrc, .profile — zero hits in install.sh or any other file
- **Privilege escalation**: no sudo in install.sh; no binary downloads; no curl|bash pattern
- **TCP binding address**: confirmed 127.0.0.1 in both mcp-server.js and native-host.js
- **Supply chain**: package.json declares only `@modelcontextprotocol/sdk ^1.12.1`; lock file resolves to 1.29.0 from registry.npmjs.org; all transitive deps are legitimate MCP SDK dependencies from npmjs.org; no git/URL deps; no postinstall scripts on any package
- **Manifest permissions**: tabs, debugger, activeTab, scripting, nativeMessaging, tabGroups, windows, storage, alarms — all accounted for by the 18 documented tools; no cookies, management, or webRequest permissions
- **Content script**: content.js performs only DOM accessibility tree traversal, element reference mapping, form value setting, and page text extraction — no network calls, no credential reads

## Recommendations

None. No malicious findings to remediate.

The one code-quality note (ref string interpolation in Runtime.evaluate at background.js:851) is worth hardening in a future refactor — use a message-passing approach instead of string interpolation — but it is not exploitable in the current trust model where all callers are the local Claude Code process.
