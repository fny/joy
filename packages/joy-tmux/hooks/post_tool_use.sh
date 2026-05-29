#!/usr/bin/env bash
INPUT=$(cat)
curl -s -X POST http://127.0.0.1:8890/hook \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"post_tool_use\",\"payload\":$INPUT}" \
  > /dev/null 2>&1 &
exit 0
