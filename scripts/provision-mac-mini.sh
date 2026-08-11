#!/bin/bash
set -euo pipefail
eval "$(/opt/homebrew/bin/brew shellenv)"
if ! grep -q 'brew shellenv' ~/.zprofile 2>/dev/null; then
  echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
fi
echo "brew=$(command -v brew)"

echo "INSTALL_GH"
brew list gh >/dev/null 2>&1 || brew install gh

echo "INSTALL_OLLAMA"
brew list ollama >/dev/null 2>&1 || brew install ollama
export OLLAMA_HOST=0.0.0.0:11434
# Persist OLLAMA_HOST for brew services
mkdir -p ~/Library/LaunchAgents
brew services restart ollama || brew services start ollama || true
sleep 3

echo "gh=$(command -v gh)"
echo "ollama=$(command -v ollama)"
ollama --version || true
curl -s -o /dev/null -w "ollama_http=%{http_code}\n" http://127.0.0.1:11434/api/tags || true

echo "ENABLE_SCREEN_SHARING"
sudo /System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart \
  -activate -configure -access -on -restart -agent -privs -all -allowAccessFor -allUsers
launchctl list | grep -i screen || true
echo "ALL_DONE"
