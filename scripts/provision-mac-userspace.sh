#!/bin/bash
# User-space Homebrew + ollama + gh — no sudo required.
set -euo pipefail
export HOMEBREW_NO_AUTO_UPDATE=1
export HOMEBREW_NO_ANALYTICS=1
PREFIX="$HOME/.fleet-homebrew"
if [ ! -x "$PREFIX/bin/brew" ]; then
  echo "BOOTSTRAP_USER_HOMEBREW"
  mkdir -p "$PREFIX"
  curl -fsSL https://github.com/Homebrew/brew/tarball/master | tar xz --strip 1 -C "$PREFIX"
fi
eval "$("$PREFIX/bin/brew" shellenv)"
grep -q 'fleet-homebrew' ~/.zprofile 2>/dev/null || echo "eval \"\$(\"$PREFIX/bin/brew\" shellenv)\"" >> ~/.zprofile
echo "brew=$(command -v brew)"

echo "INSTALL_GH"
brew list gh >/dev/null 2>&1 || brew install gh

echo "INSTALL_OLLAMA"
brew list ollama >/dev/null 2>&1 || brew install ollama
export OLLAMA_HOST=127.0.0.1:11434
# user-level launch agent
mkdir -p ~/Library/LaunchAgents
brew services restart ollama || brew services start ollama || {
  # fallback: run in background
  nohup ollama serve >/tmp/ollama.log 2>&1 &
  sleep 2
}
sleep 2
echo "gh=$(command -v gh || true)"
echo "ollama=$(command -v ollama || true)"
curl -s -o /dev/null -w "ollama_http=%{http_code}\n" http://127.0.0.1:11434/api/tags || true
# Screen sharing without sudo — report only
lsof -nP -iTCP:5900 -sTCP:LISTEN 2>/dev/null || echo "5900_NOT_LISTENING (needs admin to enable)"
echo ALL_DONE
