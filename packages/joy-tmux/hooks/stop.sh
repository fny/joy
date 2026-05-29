#!/usr/bin/env bash
# Stop hook — forward the last assistant message from the transcript to the web UI
INPUT=$(cat)
TRANSCRIPT=$(echo "$INPUT" | jq '.transcript // []' 2>/dev/null)
if [ -n "$TRANSCRIPT" ] && [ "$TRANSCRIPT" != "[]" ]; then
  curl -s -X POST http://127.0.0.1:8890/hook \
    -H "Content-Type: application/json" \
    -d "{\"type\":\"stop\",\"transcript\":$TRANSCRIPT}" \
    > /dev/null 2>&1 &
fi
exit 0
