#!/usr/bin/env bash
# Universal hook forwarder — reads hook_event_name from stdin and POSTs to webchat server
INPUT=$(cat)
EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // "UnknownHook"' 2>/dev/null)
curl -s -X POST http://127.0.0.1:8890/hook \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"$EVENT\",\"payload\":$INPUT}" \
  > /dev/null 2>&1 &
exit 0
