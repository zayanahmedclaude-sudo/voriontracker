#!/usr/bin/env bash
# Vorion Tracker — macOS installer
# Usage: curl -fsSL https://your-app.vercel.app/api/agent/install-mac.sh | bash
# Or for MDM (Jamf/Mosyle): run as a script policy

set -e

APP_URL="${WORKTRACK_SERVER:-https://your-app.vercel.app}"
DMG_PATH="/tmp/Vorion-Tracker.dmg"
APP_NAME="Vorion Tracker.app"
INSTALL_DIR="/Applications"
PLIST_PATH="$HOME/Library/LaunchAgents/com.yourcompany.vorion-tracker.plist"

echo "Installing Vorion Tracker for macOS..."

# ── Download DMG ─────────────────────────────────────────────────────────────
echo "[1/4] Downloading..."
curl -L --progress-bar "$APP_URL/api/agent/download?platform=mac" -o "$DMG_PATH"

# ── Mount and copy ────────────────────────────────────────────────────────────
echo "[2/4] Installing to /Applications..."
MOUNT_POINT=$(hdiutil attach "$DMG_PATH" -nobrowse -quiet | tail -1 | awk '{print $3}')
cp -R "$MOUNT_POINT/$APP_NAME" "$INSTALL_DIR/"
hdiutil detach "$MOUNT_POINT" -quiet
rm -f "$DMG_PATH"

# Remove quarantine flag (avoids Gatekeeper warning for internal tools)
xattr -dr com.apple.quarantine "$INSTALL_DIR/$APP_NAME" 2>/dev/null || true

# ── macOS Screen Recording permission notice ──────────────────────────────────
echo "[3/4] Granting permissions..."
cat <<'MSG'

  ⚠️  macOS requires manual permission for screen recording.
  
  After the app opens:
  1. Go to System Settings → Privacy & Security → Screen Recording
  2. Enable "Vorion Tracker"
  3. The app will restart automatically

MSG

# ── LaunchAgent for auto-start ────────────────────────────────────────────────
echo "[4/4] Setting up auto-start..."
mkdir -p "$(dirname "$PLIST_PATH")"
cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.yourcompany.vorion-tracker</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Applications/Vorion Tracker.app/Contents/MacOS/Vorion Tracker</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>WORKTRACK_SERVER</key>
        <string>$APP_URL</string>
    </dict>
    <key>StandardErrorPath</key>
    <string>/tmp/vorion-tracker.log</string>
</dict>
</plist>
EOF

launchctl load "$PLIST_PATH" 2>/dev/null || launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || true

# ── Launch ────────────────────────────────────────────────────────────────────
open "$INSTALL_DIR/$APP_NAME"

echo ""
echo "✅ Vorion Tracker installed successfully!"
echo "   Sign in with your company email when the app opens."
echo "   The agent icon will appear in your menu bar."
echo ""
echo "   To uninstall: rm -rf '/Applications/Vorion Tracker.app' && launchctl remove com.yourcompany.vorion-tracker"
