#!/usr/bin/env bash
# UserPromptSubmit hook — forward CLI user input to the web UI
# Reads JSON on stdin, extracts .prompt, POSTs to webchat server.
# Must NOT write to stdout (that would modify the prompt).
INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty' 2>/dev/null)
# Skip channel injections — they originate from the web UI, not the CLI
if [ -n "$PROMPT" ] && ! echo "$PROMPT" | grep -q '^<channel source="webchat"'; then
  curl -s -X POST http://127.0.0.1:8890/hook \
    -H "Content-Type: application/json" \
    -d "{\"type\":\"user_input\",\"content\":$(echo "$PROMPT" | jq -Rs .)}" \
    > /dev/null 2>&1 &
fi
# Exit 0, no stdout — Claude Code uses original prompt unchanged
exit 0
