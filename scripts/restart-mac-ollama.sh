#!/bin/bash
set -euo pipefail
eval "$(/opt/homebrew/bin/brew shellenv)"
export OLLAMA_HOST=0.0.0.0:11434
# Ensure plist has OLLAMA_HOST
PLIST="$(brew --prefix)/opt/ollama/homebrew.mxcl.ollama.plist"
/usr/libexec/PlistBuddy -c 'Delete :EnvironmentVariables' "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c 'Add :EnvironmentVariables dict' "$PLIST"
/usr/libexec/PlistBuddy -c 'Add :EnvironmentVariables:OLLAMA_HOST string 0.0.0.0:11434' "$PLIST"
brew services restart ollama
sleep 4
echo "local_http=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:11434/api/tags)"
lsof -nP -iTCP:11434 -sTCP:LISTEN || true
# macOS firewall: allow ollama if socketfilterfw present
if command -v /usr/libexec/ApplicationFirewall/socketfilterfw >/dev/null 2>&1; then
  BIN="$(command -v ollama)"
  sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "$BIN" 2>/dev/null || true
  sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp "$BIN" 2>/dev/null || true
fi
echo DONE
