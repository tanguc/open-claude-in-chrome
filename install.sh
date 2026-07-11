#!/bin/bash
set -e

# Install script for Open Claude in Chrome extension.
# Registers the native messaging host for Chrome, Edge, and Brave.
#
# Usage: ./install.sh <extension-id> [extension-id-2] [extension-id-3] ...
#
# Pass one extension ID per browser. Each Chromium browser assigns a different
# ID when loading unpacked extensions, so if you use both Chrome and Brave,
# pass both IDs.

if [ -z "$1" ]; then
  echo "Usage: ./install.sh <extension-id> [extension-id-2] ..."
  echo ""
  echo "Pass one extension ID per browser you want to use."
  echo "Each browser assigns a different ID to the same unpacked extension."
  echo ""
  echo "Steps:"
  echo "  1. Open chrome://extensions (and/or brave://extensions)"
  echo "  2. Enable Developer Mode"
  echo "  3. Click 'Load unpacked' and select the extension/ directory"
  echo "  4. Copy the extension ID shown under the extension name"
  echo "  5. Repeat for each browser"
  echo "  6. Run: ./install.sh <chrome-id> <brave-id>"
  exit 1
fi

EXTENSION_IDS=("$@")
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_DIR="$SCRIPT_DIR/host"
HOST_NAME="com.anthropic.open_claude_in_chrome"

# The native host is launched BY THE BROWSER (a sandboxed GUI app), not by your
# shell. On macOS, TCC forbids GUI apps from reading/executing on removable or
# network volumes (/Volumes/*) unless explicitly granted. So if this repo lives
# on an external SSD — directly or via a ~ symlink — the browser cannot execute a
# native host stored inside it: connectNative dies immediately with "Native host
# has exited". To stay robust regardless of where the repo lives, install the
# native host into a stable internal per-user location and point the manifests
# there. (native-host.js has no npm deps, so a plain copy is self-contained.)
case "$(uname)" in
  Darwin) INSTALL_DIR="$HOME/Library/Application Support/open-claude-in-chrome" ;;
  *)      INSTALL_DIR="$HOME/.local/share/open-claude-in-chrome" ;;
esac
NATIVE_HOST_PATH="$INSTALL_DIR/native-host-wrapper.sh"

# Verify node is available
if ! command -v node &> /dev/null; then
  echo "Error: node is not installed. Install Node.js first."
  exit 1
fi

# Verify npm dependencies are installed
if [ ! -d "$HOST_DIR/node_modules" ]; then
  echo "Installing npm dependencies..."
  cd "$HOST_DIR" && npm install
  cd "$SCRIPT_DIR"
fi

# Install the native host onto the internal disk (see note above). The repo copy
# stays the source of truth; edits to host/native-host.js require re-running this
# script to refresh the installed copy.
mkdir -p "$INSTALL_DIR"
cp "$HOST_DIR/native-host.js" "$INSTALL_DIR/native-host.js"

# Create the native host wrapper script. The browser launches this via native
# messaging — it needs an absolute path to node and to the installed script.
cat > "$NATIVE_HOST_PATH" << WRAPPER
#!/bin/sh
exec "$(which node)" "$INSTALL_DIR/native-host.js"
WRAPPER
chmod +x "$NATIVE_HOST_PATH"

echo "Installed native host to internal disk: $INSTALL_DIR"

# Warn if the repo itself resolves onto a removable/external volume — that is
# exactly the setup this internal install protects against.
REAL_HOST_DIR="$(cd "$HOST_DIR" && pwd -P)"
case "$REAL_HOST_DIR" in
  /Volumes/*)
    echo "  Note: repo resolves to $REAL_HOST_DIR (external/removable volume)."
    echo "  The native host was installed internally so the browser can execute it"
    echo "  (macOS TCC blocks GUI apps from running binaries on /Volumes/*)."
    ;;
esac

# Build allowed_origins array from all extension IDs
ORIGINS=""
for i in "${!EXTENSION_IDS[@]}"; do
  if [ $i -gt 0 ]; then ORIGINS="$ORIGINS,"; fi
  ORIGINS="$ORIGINS
    \"chrome-extension://${EXTENSION_IDS[$i]}/\""
done

# Native messaging host manifest
generate_manifest() {
  cat << EOF
{
  "name": "$HOST_NAME",
  "description": "Open Claude in Chrome Native Messaging Host",
  "path": "$NATIVE_HOST_PATH",
  "type": "stdio",
  "allowed_origins": [$ORIGINS
  ]
}
EOF
}

# Platform-specific installation
install_host() {
  local browser_name="$1"
  local host_dir="$2"

  if [ ! -d "$(dirname "$host_dir")" ]; then
    echo "  Skipping $browser_name (not installed)"
    return
  fi

  mkdir -p "$host_dir"
  generate_manifest > "$host_dir/$HOST_NAME.json"
  echo "  Installed for $browser_name: $host_dir/$HOST_NAME.json"
}

echo ""
echo "Installing native messaging host for extension(s): ${EXTENSION_IDS[*]}"
echo ""

case "$(uname)" in
  Darwin)
    install_host "Google Chrome" \
      "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    install_host "Microsoft Edge" \
      "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
    install_host "Brave Browser" \
      "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    ;;
  Linux)
    install_host "Google Chrome" \
      "$HOME/.config/google-chrome/NativeMessagingHosts"
    install_host "Microsoft Edge" \
      "$HOME/.config/microsoft-edge/NativeMessagingHosts"
    install_host "Brave Browser" \
      "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    ;;
  *)
    echo "Error: Unsupported platform $(uname). This script supports macOS and Linux."
    echo "For Windows, manually create the registry entries and host manifest."
    exit 1
    ;;
esac

echo ""
echo "Done! Next steps:"
echo ""
echo "  1. Restart your browser (close all windows and reopen)"
echo "  2. Add the MCP server to Claude Code:"
echo ""
echo "     claude mcp add open-claude-in-chrome -- node $HOST_DIR/mcp-server.js"
echo ""
echo "  3. Start a new Claude Code session and test:"
echo ""
echo '     Ask Claude: "Navigate to reddit.com and take a screenshot"'
echo ""
