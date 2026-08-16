#!/bin/bash
set -euo pipefail
export OLLAMA_HOST=127.0.0.1:11434

measure() {
  local label="$1"
  local file="$2"
  echo "=== $label ==="
  curl -s http://127.0.0.1:11434/api/generate -d @"$file" > "/tmp/ollama-$label.json"
  python3 - "$label" <<'PY'
import json,sys
label=sys.argv[1]
d=json.load(open(f'/tmp/ollama-{label}.json'))
if 'error' in d:
  print('ERROR', d['error']); raise SystemExit(1)
ec=d.get('eval_count') or 0
ed=d.get('eval_duration') or 1
pc=d.get('prompt_eval_count') or 0
pd=d.get('prompt_eval_duration') or 1
print('eval_count', ec, 'eval_tps', round(ec/(ed/1e9),2))
print('prompt_count', pc, 'prompt_tps', round(pc/(pd/1e9),2) if pd else None)
print('total_ms', round((d.get('total_duration') or 0)/1e6,1))
print('response_head', (d.get('response') or '')[:180].replace('\n',' '))
print('thinking_head', str(d.get('thinking') or '')[:120].replace('\n',' '))
PY
}

cat > /tmp/req-default.json <<'EOF'
{"model":"gemma4:e2b","prompt":"Explain what a WireGuard mesh network is and why it removes the need for port forwarding. Answer in one paragraph.","stream":false,"options":{"num_ctx":8192,"temperature":0,"seed":42,"num_predict":192}}
EOF

cat > /tmp/req-nothink.json <<'EOF'
{"model":"gemma4:e2b","prompt":"Explain what a WireGuard mesh network is and why it removes the need for port forwarding. Answer in one paragraph.","stream":false,"think":false,"options":{"num_ctx":8192,"temperature":0,"seed":42,"num_predict":192}}
EOF

cat > /tmp/req-short.json <<'EOF'
{"model":"gemma4:e2b","prompt":"Reply with exactly the word: ready","stream":false,"think":false,"options":{"num_ctx":8192,"temperature":0,"seed":42,"num_predict":16}}
EOF

measure default /tmp/req-default.json
measure nothink /tmp/req-nothink.json
measure short /tmp/req-short.json
