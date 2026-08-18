#!/usr/bin/env bash
# Vorion Tracker — macOS installer
# Usage: curl -fsSL https://your-app.vercel.app/api/agent/install-mac.sh | bash
# Or for MDM (Jamf/Mosyle): run as a script policy

set -e

APP_URL="${WORKTRACK_SERVER:-https://api.vorionsystems.com}"
DMG_PATH="/tmp/Vorion-Tracker.dmg"
APP_NAME="Vorion Tracker.app"
INSTALL_DIR="/Applications"
PLIST_PATH="$HOME/Library/LaunchAgents/com.yourcompany.vorion-tracker.plist"
SKIP_DEVICE_CHECK="${SKIP_DEVICE_CHECK:-0}"

echo "Installing Vorion Tracker for macOS..."

if [ "$SKIP_DEVICE_CHECK" != "1" ]; then
  echo "[0/5] Verifying this is a company-managed device..."
  DEVICE_CHECK=$(curl -fsSL -X POST "$APP_URL/api/agent/device-check" \
    -H "Content-Type: application/json" \
    -d "{\"hostname\":\"$(scutil --get ComputerName 2>/dev/null || hostname)\",\"platform\":\"darwin\",\"installScope\":\"launch-agent\"}")
  echo "$DEVICE_CHECK" | grep -q '"allowed":true' || {
    echo "Install blocked: this device is not approved for company monitoring."
    exit 1
  }
fi

# ── Download DMG ─────────────────────────────────────────────────────────────
echo "[1/5] Downloading..."
curl -L --progress-bar "$APP_URL/api/agent/download?platform=mac" -o "$DMG_PATH"

# ── Mount and copy ────────────────────────────────────────────────────────────
echo "[2/5] Installing to /Applications..."
MOUNT_POINT=$(hdiutil attach "$DMG_PATH" -nobrowse -quiet | tail -1 | awk '{print $3}')
cp -R "$MOUNT_POINT/$APP_NAME" "$INSTALL_DIR/"
hdiutil detach "$MOUNT_POINT" -quiet
rm -f "$DMG_PATH"

# Remove quarantine flag (avoids Gatekeeper warning for internal tools)
xattr -dr com.apple.quarantine "$INSTALL_DIR/$APP_NAME" 2>/dev/null || true

# ── macOS Screen Recording permission notice ──────────────────────────────────
echo "[3/5] Granting permissions..."
cat <<'MSG'

  ⚠️  macOS requires manual permission for screen recording.
  
  After the app opens:
  1. Go to System Settings → Privacy & Security → Screen Recording
  2. Enable "Vorion Tracker"
  3. The app will restart automatically

MSG

# ── LaunchAgent for auto-start ────────────────────────────────────────────────
echo "[4/5] Setting up auto-start..."
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
    <true/>
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
echo "[5/5] Launching app..."
open "$INSTALL_DIR/$APP_NAME"

echo ""
echo "✅ Vorion Tracker installed successfully!"
echo "   Sign in with your company email when the app opens."
echo "   The agent icon will appear in your menu bar."
echo ""
echo "   To uninstall: rm -rf '/Applications/Vorion Tracker.app' && launchctl remove com.yourcompany.vorion-tracker"
