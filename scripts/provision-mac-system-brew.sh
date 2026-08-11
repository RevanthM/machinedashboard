#!/bin/bash
set -euo pipefail
eval "$(/opt/homebrew/bin/brew shellenv)"
grep -q 'brew shellenv' ~/.zprofile 2>/dev/null || echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
echo "brew=$(command -v brew)"
echo "INSTALL_GH"
brew list gh >/dev/null 2>&1 || brew install gh
echo "INSTALL_OLLAMA"
brew list ollama >/dev/null 2>&1 || brew install ollama
export OLLAMA_HOST=0.0.0.0:11434
PLIST="$(brew --prefix)/opt/ollama/homebrew.mxcl.ollama.plist"
if [ -f "$PLIST" ]; then
  /usr/libexec/PlistBuddy -c 'Delete :EnvironmentVariables' "$PLIST" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c 'Add :EnvironmentVariables dict' "$PLIST" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c 'Add :EnvironmentVariables:OLLAMA_HOST string 0.0.0.0:11434' "$PLIST" 2>/dev/null || \
  /usr/libexec/PlistBuddy -c 'Set :EnvironmentVariables:OLLAMA_HOST 0.0.0.0:11434' "$PLIST" 2>/dev/null || true
fi
brew services restart ollama || brew services start ollama || (nohup ollama serve >/tmp/ollama.log 2>&1 & sleep 2)
sleep 2
echo "gh=$(command -v gh)"
echo "ollama=$(command -v ollama)"
ollama --version || true
curl -s -o /dev/null -w "ollama_http=%{http_code}\n" http://127.0.0.1:11434/api/tags || true
lsof -nP -iTCP:5900 -sTCP:LISTEN 2>/dev/null || echo "5900_NOT_LISTENING"
echo ALL_DONE
