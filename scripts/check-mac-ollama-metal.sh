#!/bin/bash
set -euo pipefail
eval "$(/opt/homebrew/bin/brew shellenv)"
echo "=== tags ==="
curl -s http://127.0.0.1:11434/api/tags | head -c 800; echo
echo "=== ps ==="
curl -s http://127.0.0.1:11434/api/ps; echo
echo "=== version ==="
ollama --version
echo "=== metal env ==="
launchctl getenv OLLAMA_HOST || true
plutil -p "$(brew --prefix)/opt/ollama/homebrew.mxcl.ollama.plist" 2>/dev/null | head -40 || true
# Quick metal-capable generate sample
echo "=== quick generate ==="
curl -s http://127.0.0.1:11434/api/generate -d '{
  "model":"gemma4:e2b",
  "prompt":"Reply with exactly the word: ready",
  "stream":false,
  "options":{"num_ctx":8192,"temperature":0,"seed":42,"num_predict":16}
}' | python3 -c 'import sys,json; d=json.load(sys.stdin); print({k:d.get(k) for k in ["eval_count","eval_duration","prompt_eval_count","prompt_eval_duration","load_duration","total_duration"]}); ec=d.get("eval_count") or 0; ed=d.get("eval_duration") or 1; print("eval_tps", round(ec/(ed/1e9),2) if ed else None)'
echo "=== ps after ==="
curl -s http://127.0.0.1:11434/api/ps; echo
