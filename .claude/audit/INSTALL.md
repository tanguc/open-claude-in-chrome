# Install Audit

## Summary

install.sh is a straightforward, no-privilege installer that writes only native-messaging manifest JSON files into per-browser user directories and generates a thin wrapper script in the repo's own host/ directory. No network calls, no sudo, no shell rc modifications. The main defects are: missing set -u/-o pipefail, no extension ID validation, and incomplete browser coverage vs. README.

## Files written

| Path | Purpose | Mode | Verdict |
|---|---|---|---|
| `$SCRIPT_DIR/host/native-host-wrapper.sh` | Thin launcher for node native-host.js | 0755 (chmod +x) | OK — stays inside repo |
| `$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.anthropic.open_claude_in_chrome.json` | Chrome manifest | default (umask) | OK |
| `$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.anthropic.open_claude_in_chrome.json` | Edge manifest | default (umask) | OK |
| `$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.anthropic.open_claude_in_chrome.json` | Brave manifest | default (umask) | OK |
| Linux equivalents under `$HOME/.config/...` | same | default | OK |

Nothing written outside user home. No LaunchAgents, no shell rc, no /etc, no /usr/local.

## Browser coverage

| Browser (README) | Handled by install.sh? | Path |
|---|---|---|
| Google Chrome | yes | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts` |
| Microsoft Edge | yes | `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts` |
| Brave | yes | `~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts` |
| Arc | NO | not implemented |
| Opera | NO | not implemented |
| Vivaldi | NO | not implemented |

Arc path: `~/Library/Application Support/Arc/User Data/NativeMessagingHosts`
Opera path: `~/Library/Application Support/com.operasoftware.Opera/NativeMessagingHosts`
Vivaldi path: `~/Library/Application Support/Vivaldi/NativeMessagingHosts`

## Findings

- **HIGH** no extension ID validation — install.sh:29,62-63
  - What: `EXTENSION_IDS=("$@")` stores all positional args verbatim; each is interpolated directly into the JSON manifest (`"chrome-extension://${EXTENSION_IDS[$i]}/"`) and into the manifest file path with no sanitisation.
  - Impact: an ID containing `"`, `\n`, or JSON special chars corrupts the manifest and silently breaks native messaging for all browsers. An ID with `/` or `..` injected into `$host_dir/$HOST_NAME.json` path could write outside the intended directory (low real-world risk since installer is run manually, but still a correctness defect).
  - Fix: validate each ID against `^[a-z]{32}$` before use; exit with a clear error on mismatch.

- **MEDIUM** `set -e` only — no `-u` or `-o pipefail` — install.sh:2
  - What: script uses `set -e` but not `set -euo pipefail`. Unbound variable references silently expand to empty string; pipeline failures are ignored.
  - Impact: if `$1` were somehow empty after the guard (e.g. due to quoting edge cases in exotic shells), empty strings would be written into the manifest JSON without error.
  - Fix: change to `set -euo pipefail`.

- **MEDIUM** missing browsers vs. README — install.sh:99-121
  - What: README advertises Arc, Opera, Vivaldi. None are in the `case` block.
  - Impact: users of those browsers follow install docs, run the script, see "Done!", and get silent failures when the extension tries to connect — no manifest was installed for their browser.
  - Fix: add install_host calls for the three missing browsers on both Darwin and Linux branches.

- **LOW** wrapper script generated at install time, not committed — install.sh:50-53
  - What: `host/native-host-wrapper.sh` is created by `cat > "$NATIVE_HOST_PATH" << WRAPPER ... WRAPPER`. The path is hardcoded to the repo checkout location at install time.
  - Impact: if the repo is moved or renamed after install, the manifest `path` field still points to the old location and native messaging silently fails. Re-running install.sh from the new location fixes it, but this is non-obvious.
  - Fix: document this in README; or note it as a known limitation.

- **LOW** `cd "$HOST_DIR" && npm install` without returning to `$SCRIPT_DIR` on failure — install.sh:44-45
  - What: if `npm install` fails, `set -e` exits the script mid-directory-change. This is benign but `cd "$SCRIPT_DIR"` on line 45 only runs on success; the cwd side-effect is harmless since the rest of the script uses absolute paths.
  - Fix: use `(cd "$HOST_DIR" && npm install)` subshell to avoid cwd mutation entirely.

- **INFO** no uninstall path
  - What: there is no `uninstall.sh` or `--uninstall` flag. Manifests and wrapper remain on disk if the extension is removed.
  - Impact: cosmetic / minor. Stale manifests cause a benign one-time error in browser logs.
  - Fix: add an uninstall.sh or document manual removal paths.

- **INFO** manifest file mode uses process umask — install.sh:91
  - What: `generate_manifest > "$host_dir/$HOST_NAME.json"` inherits the user's umask. Typically 0644 (world-readable), which is standard for these system-level JSON files.
  - Impact: none in practice; NativeMessagingHosts manifests are conventionally world-readable.
  - Fix: none required; explicit `chmod 644` could be added for defensive clarity.

## Cross-reference checks

- Native host name install.sh (`HOST_NAME="com.anthropic.open_claude_in_chrome"`, line 33) vs. extension/background.js (`NATIVE_HOST_NAME = "com.anthropic.open_claude_in_chrome"`, line 9): **match**
- Wrapper script present at time of audit: **no** (generated at install time, not pre-committed) — verdict: by design, but means the file doesn't exist until install.sh is run; `.gitignore` should exclude it to avoid accidental commits with hardcoded paths.

## What I checked

- Read install.sh in full (134 lines)
- Grepped install.sh for: sudo, curl, wget, eval, rm -rf, .zshrc, .bashrc, /etc/, /usr/local, LaunchAgent — none found
- Checked host/ directory listing — native-host-wrapper.sh absent (not pre-committed)
- Grepped extension/background.js for NATIVE_HOST_NAME constant and connectNative call
- Cross-referenced HOST_NAME in install.sh against NATIVE_HOST_NAME in background.js
- Verified all file writes are under $HOME or $SCRIPT_DIR
- Checked browser list in README against case blocks in install.sh
- Checked input handling: EXTENSION_IDS array assignment, JSON interpolation, path construction
- Verified wrapper generation: heredoc, chmod +x, absolute path to node via $(which node)
- Checked idempotency: overwrite via `>` redirection — clean, no duplicates
