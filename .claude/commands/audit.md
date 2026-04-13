---
description: Run the full audit sub-agent team on open-claude-in-chrome in parallel (malicious, extension, host, install).
---

Run a full audit of the repo by spawning all four audit sub-agents **in parallel** using the Agent tool. Each agent writes its own report under `.claude/audit/`. Do NOT do the audit work inline — delegate.

## Step 1 — prepare

Ensure `.claude/audit/` exists (create it if not). Do not pre-populate any files.

## Step 2 — spawn all four agents in parallel

In a single assistant message, issue four Agent tool calls (one message, four tool_use blocks). Use `subagent_type` for each, pass `model: "sonnet"` explicitly, and give each a self-contained brief:

1. `audit-malicious` — "Audit the open-claude-in-chrome repo for malicious code, backdoors, exfiltration, or anything that would make it unsafe to run. Write your report to `.claude/audit/MALICIOUS.md`. Follow your system prompt. Be concrete, cite file:line, do not invent findings."

2. `audit-extension` — "Audit `extension/manifest.json`, `extension/background.js`, `extension/content.js` for correctness, permission hygiene, and extension-side attack surface. Write to `.claude/audit/EXTENSION.md`. Follow your system prompt."

3. `audit-host` — "Audit `host/mcp-server.js`, `host/native-host.js`, `host/package.json`, `host/package-lock.json` for IPC correctness, bind surface, multi-session lifecycle, and MCP protocol safety. Write to `.claude/audit/HOST.md`. Follow your system prompt."

4. `audit-install` — "Audit `install.sh`, any wrapper script, and the native-messaging manifest flow for correctness and footprint. Write to `.claude/audit/INSTALL.md`. Follow your system prompt."

All four run read-only (Read/Grep/Glob/Bash). They do not edit source files.

## Step 3 — collate

Once all four agents return, read the four report files and produce a top-level `.claude/audit/SUMMARY.md` with:

- **Overall verdict** on one line (CLEAN / SUSPICIOUS / ISSUES / MALICIOUS — propagate the worst individual verdict, with the malicious auditor taking precedence for trust questions)
- **Top findings** table: severity, title, file:line, which report it came from
- **Per-report status**: one line each linking to MALICIOUS.md, EXTENSION.md, HOST.md, INSTALL.md with each agent's own summary line
- **Recommended next actions** if any HIGH/CRITICAL findings exist

Keep SUMMARY.md under 150 lines. It's the entry point — the detail lives in the four reports.

## Step 4 — report to user

Reply to the user with a short summary (≤10 lines): overall verdict, count of findings by severity, and the path to `.claude/audit/SUMMARY.md`. Do not paste the full reports.
