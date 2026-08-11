#!/bin/bash
set -euo pipefail
echo "TRY_SCREEN_SHARING"
# Sequoia often rejects kickstart; enable the launch daemon directly.
sudo launchctl enable system/com.apple.screensharing 2>/dev/null || true
if [ -f /System/Library/LaunchDaemons/com.apple.screensharing.plist ]; then
  sudo launchctl bootstrap system /System/Library/LaunchDaemons/com.apple.screensharing.plist 2>/dev/null || \
  sudo launchctl load -w /System/Library/LaunchDaemons/com.apple.screensharing.plist 2>/dev/null || true
fi
sudo launchctl kickstart -k system/com.apple.screensharing 2>/dev/null || true
# Also try sharing prefs (older path)
sudo defaults write /var/db/launchd.db/com.apple.launchd/overrides.plist com.apple.screensharing -dict Disabled -bool false 2>/dev/null || true
launchctl print system/com.apple.screensharing 2>&1 | head -20 || true
# Is anything listening on 5900?
lsof -nP -iTCP:5900 -sTCP:LISTEN 2>/dev/null || netstat -an | grep '\.5900' || echo "5900_NOT_LISTENING"
# Ensure OLLAMA_HOST persists in the brew service plist
eval "$(/opt/homebrew/bin/brew shellenv)"
PLIST="$(brew --prefix)/opt/ollama/homebrew.mxcl.ollama.plist"
if [ -f "$PLIST" ]; then
  echo "patching ollama plist for OLLAMA_HOST"
  /usr/libexec/PlistBuddy -c 'Delete :EnvironmentVariables' "$PLIST" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c 'Add :EnvironmentVariables dict' "$PLIST"
  /usr/libexec/PlistBuddy -c 'Add :EnvironmentVariables:OLLAMA_HOST string 0.0.0.0:11434' "$PLIST"
  brew services restart ollama
  sleep 2
fi
curl -s http://127.0.0.1:11434/api/tags | head -c 200; echo
echo DONE
