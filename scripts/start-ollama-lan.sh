#!/bin/bash
set -euo pipefail
eval "$(/opt/homebrew/bin/brew shellenv)"
brew services stop ollama 2>/dev/null || true
pkill -x ollama 2>/dev/null || true
sleep 1
export OLLAMA_HOST=0.0.0.0:11434
nohup /opt/homebrew/opt/ollama/bin/ollama serve >/tmp/ollama-serve.log 2>&1 &
echo "pid=$!"
sleep 3
lsof -nP -iTCP:11434 -sTCP:LISTEN || true
curl -s -o /dev/null -w "local=%{http_code}\n" http://127.0.0.1:11434/api/tags
curl -s -o /dev/null -w "lan=%{http_code}\n" http://192.168.4.72:11434/api/tags || true
tail -20 /tmp/ollama-serve.log || true
