# Suite: v2-daemon — REAL agents over the v2 plane (claude, codex, pi)

Scope: the daemon's nucleus lane end to end — a real joy-daemon (from
source) claims the relay's v2 queue, spawns REAL agent sessions from v2
spawn commands, executes prompts through the actual harness, and streams
real answers back as durable v2 events. No scripted actor anywhere.

## Setup

1. Stack: `.claude/skills/e2e-tests/stack.sh reset && stack.sh start`
   (wipes accounts — this suite always starts pristine).
2. Isolated daemon home + creds (NO browser needed):
   `TOKEN=$(node .claude/skills/e2e-tests/mint-daemon-creds.mjs --relay http://127.0.0.1:3105 --home $HOME/.joy-test --machine v2-live-e2e)`
   Save $TOKEN — the SAME account drives the client side.
   (First `rm -rf $HOME/.joy-test`; the random encryption keys are fine —
   the v2 lane needs only token+machineId; happy-plane decryption for this
   throwaway account is not meaningful.)
3. Start the daemon from source on the PRIVATE tmux server (isolation rules
   in SKILL.md apply — never the default tmux socket):
   `env -u TMUX -u TMUX_PANE TMUX_TMPDIR=/tmp/joy-test-tmux HAPPY_HOME_DIR=$HOME/.joy-test JOY_RELAY_URL=http://127.0.0.1:3105 PORT=4999 TMUX_SESSION=joy-test setsid nohup pnpm -C packages/joy-daemon start > /tmp/joy-test-daemon.log 2>&1 & echo $! > /tmp/joy-test-daemon.pid`
   (record the pid — teardown kills the PROCESS GROUP by that pid, never a
   name-based pkill that could hit the live daemon)
4. Gate: `grep -m1 "\[v2-lane\] started" /tmp/joy-test-daemon.log` within
   ~20s, then `[v2-lane] lease` — the lane is claiming. If instead you see
   the lane idle-retrying, the relay is down or /joy/v2 is missing.

## Per-harness run (claude, then codex, then pi)

For AGENT in claude codex pi:

```bash
mkdir -p /tmp/v2-live-$AGENT
node .claude/skills/e2e-tests/v2-live-e2e.mjs \
  --relay http://127.0.0.1:3105 --token "$TOKEN" \
  --machine v2-live-e2e --agent $AGENT --cwd /tmp/v2-live-$AGENT
```

The driver asserts: spawn→bind (real agent boots in tmux), prompt 202,
the REAL agent's marker answer arriving as durable v2 output events —
EXACTLY once — and turn terminal + message delivered. Evidence (the v2
session) is KEPT for the artifact cross-checks; purge happens in teardown
(`--purge` on a rerun cleans an individual session). Exit 0 = pass.

Timings: claude binds in ~15-60s (CLI boot), codex/pi similar; the marker
answer allows 240s (model latency). Do not shorten these.

### Artifact cross-checks after each run (before the next agent)

- `env -u TMUX -u TMUX_PANE TMUX_TMPDIR=/tmp/joy-test-tmux tmux -L default ls 2>/dev/null; env -u TMUX -u TMUX_PANE TMUX_TMPDIR=/tmp/joy-test-tmux tmux ls`
  — a `j-<id>` window existed for the session (may be archived by teardown).
- `/tmp/joy-test-daemon.log` — the lane logged `spawned <agent>`, `turn
  <id> started`, `turn <id> completed`, and no `error:` lines for the turn.
- The marker text must NOT appear twice in the event log (exactly-once).

### Failure handling

- Spawn FAILED in the daemon log → capture the exact error (missing binary
  on the daemon's PATH is the classic: check `[v2-lane] spawn ... FAILED`).
  Fix nothing silently: report it.
- Marker timeout with the turn stuck `running` → capture
  `tmux capture-pane` of the agent window (private socket!) — the agent is
  probably sitting on a permission/login prompt. Report the pane text.
- Turn `failed (queue_paused)` → the local dispatch queue paused (pane
  damage); capture pane + daemon log.

## Cancellation spot-check (claude only, after the three passes)

Create one more session, send `Count to 1000 slowly, one number per line.`,
wait for the turn to read `running` (`GET /sessions/{id}`), then
`POST /sessions/{id}/turns/{turnId}/cancellations`. Assert the turn ends
`terminal(cancelled)` within 60s and the daemon log shows `cancel … abort
sent`. Purge the session.

## Teardown

- Kill the test daemon by its RECORDED pid group:
  `kill -- -$(cat /tmp/joy-test-daemon.pid)` — never name-based pkill (the
  live daemon matches the same names). Then kill the `joy-test` tmux session
  on the PRIVATE socket only.
- Purge the kept v2 sessions (`DELETE /joy/v2/sessions/{id}` with $TOKEN,
  or just `stack.sh reset`).
- `stack.sh stop` (leave data for forensics unless the run was clean; then
  `stack.sh reset`).
- `rm -rf /tmp/v2-live-*`. Leave the LIVE daemon and default tmux alone.

## Report format

One line per harness: `PASS|FAIL <agent> — <one-sentence evidence>`, then
any daemon-log lines worth quoting, then an overall verdict. FAILs include
the exact command to reproduce and the captured pane/log evidence.
