# pi-family (omp / pi) adapter — spike findings + design

2026-08-14. Probed omp v17.3.2 live on faraz-vip (Bun ≥1.3.14 required — 1.3.11
fails to PARSE the dist bundle; `bun upgrade` fixed it). Model: Fireworks Kimi
K3 (`omp --model fireworks/kimi-k3`, FIREWORKS_API_KEY env). Full agentic loop
verified end-to-end over RPC: prompt → thinking stream → bash tool → steer
mid-turn → retry → final answer honoring both messages.

## Why this flavor

- **Native steer/queue**: mid-turn `{"type":"steer"}` is ack'd immediately; the
  in-flight tool call is SKIPPED with a synthetic "Skipped due to queued user
  message… retry if still needed" toolResult, the turn ends, and a new turn
  starts with the steering message tagged `"steering": true`. The model then
  retries the skipped tool itself. This replaces joy's entire dispatch/queue
  machinery for this flavor. Also `follow_up`, `set_steering_mode`,
  `set_follow_up_mode` (unprobed).
- **Dual UI by construction**: daemon owns the session over RPC; the app and a
  future thin pane TUI are both just message sources + event renderers.
- **Open-model tier**: Fireworks is a native provider. This account serves
  kimi-k3 (1M ctx), kimi-k2.6/-fast, kimi-k2.7-code, deepseek-v4-*, glm-5.2,
  gpt-oss. NOTE: omp's catalog lists models the account may NOT have
  (kimi-k2.5 → Fireworks 404 "Model not found") — surface real availability,
  don't trust the catalog blindly.

## RPC protocol (probed, `--mode rpc` / `rpc-ui`)

- Spawn `omp --mode rpc --model <m> [--no-session|--session-dir d] --cwd d`.
  JSONL over stdio. Handshake: `{"type":"ready","protocolVersion":1,
  "supportedProtocolVersions":[1,2],"maxFrameBytes":1048576,…}`.
- Commands `{"type":X,…}` → ack `{"type":"response","command":X,"success":…}`.
  Probed: `get_state` (model + config + huge catalog, ~59KB — don't relay raw),
  `prompt {message}`, `steer {message}`, `abort`. Docs (pi rpc.md): follow_up,
  get_messages, set_model/cycle_model, set_thinking_level, compact, bash,
  fork/clone, switch_session, get_session_stats, export_html, set_session_name.
- Event stream:
  - `agent_start` / `agent_end {messages:[full transcript]}`
  - `turn_start` / `turn_end {message}` — turn brackets map to joy turns
  - `message_start/end {message}` role user|assistant|toolResult; user carries
    `attribution:"user"` and `steering:true` when steered
  - `message_update {assistantMessageEvent}`: thinking_start/delta/end,
    text_delta, toolcall_start/delta/end — every delta includes a full
    `partial` snapshot (VERBOSE; consume deltas, ignore partials)
  - `tool_execution_start {toolCallId,toolName,args,intent}` /
    `tool_execution_update {partialResult}` (streaming bash output!) /
    `tool_execution_end {result{content,details:{wallTimeMs,…}},isError}`
  - `available_commands_update {commands:[{name,description,subcommands}]}` —
    feeds the app command palette directly (~15KB, incl. /security etc.)
  - `extension_ui_request {id,method:"setWidget",…}` — extension widget
    plumbing; adapter should no-op/ack politely (TODO: check if reply needed)
- Usage/cost per assistant message (`usage.{input,output,cacheRead,cost{…}}`) —
  context meter + usage reporting come free. kimi-k3 run showed cacheRead
  populated (Fireworks prompt cache).
- `rpc-ui` mode: same stream (tool cards not obviously different in this probe;
  revisit before building the pane TUI).

## Adapter design (mirror opencodeSession.ts shape)

`src/omp/ompSession.ts` + registry flavor `"omp"`:
- Spawn per session: `omp --mode rpc --model <m> --cwd <dir> --session-dir
  <joyStateDir>/omp/<sessionId>` (persistent sessions → resume via
  `--resume`/`switch_session`; probe before building).
- Relay mapping: turn_start/end → joy turn brackets; message user rows ←
  message_end(role user); assistant text ← text deltas at message_end;
  tool_execution_* → joy tool events; thinking stream → thinking flag;
  usage → joy__context/usage.
- Send path: idle → `prompt`; mid-turn → `steer` (native!) — no dispatch gate,
  no queue valve needed for this flavor.
- Model switch: `set_model` RPC (app model picker works mid-session);
  effort ← `set_thinking_level` (kimi-k3: low/high/max).
- Commands: `available_commands_update` → metadata slashCommands.
- No tmux pane initially (like opencode). Dual-UI pane TUI is phase 2: thin
  client rendering the daemon's event feed + input line (rpc-ui cards may
  help). Phase 3 option: upstream "attach" support.

## Open questions / TODOs before building

1. Tool approval/permissions: the probe's bash ran with NO approval event —
   what's the default policy and what does an approval request look like
   non-yolo? (joy permission modes need this.)
2. Session persistence + restart reconcile: --session-dir + get_messages
   backfill; does a fresh RPC process resume a session cleanly?
3. follow_up vs steer mode defaults; set_steering_mode semantics.
4. extension_ui_request handling contract.
5. Bun on fleet boxes: omp needs Bun ≥~1.3.14 at runtime; joy-daemon stays on
   Node — omp is just a spawned binary, but boxes need bun installed + fresh.
6. FIREWORKS_API_KEY must be in the daemon environment (systemd unit env or
   sourced file) — currently only in ~/.fny/secrets/env.sh on faraz-vip.

## Vanilla pi comparison (probed 2026-08-14, @earendil-works/pi-coding-agent 0.84.1)

Same protocol family — the adapter can target BOTH behind one flag. Deltas:

- **Runtime: Node ≥22.19** (no Bun!) — pi is the fleet-friendly one; omp needs
  Bun ≥1.3.14 kept fresh on every box.
- **Steer semantics differ** (both verified live, same scenario):
  - omp: INTERRUPT-flavored — skips the in-flight tool with a synthetic
    "retry me" result, new turn immediately.
  - pi: QUEUE-flavored — the in-flight tool RUNS to completion, turn finishes
    ("DONE"), then the steer delivers as its own turn (model ran `date +%Y`
    and answered). Matches pi rpc.md.
  - pi also emits `queue_update {steering:[…],followUp:[…]}` — live queue
    contents as events → the app's queue strip could render the HARNESS queue
    natively. omp did not emit this in the probe.
- pi's `get_state` is compact (~1KB model info vs omp's ~59KB dump); pi
  resolved `fireworks/kimi-k3` to `accounts/fireworks/routers/kimi-k3-fast`
  (router/fast variant, $4.5/$22.5 per M) — pin exact ids in the adapter, the
  fuzzy match picks variants.
- No `available_commands_update` / `extension_ui_request` seen from pi in the
  probe — omp extras (richer, but more surface).
- Fireworks/Kimi K3 works on both out of the box with FIREWORKS_API_KEY.
- pi one-shot: `pi --model fireworks/kimi-k3 -p …` — worked identically.

Recommendation: build the adapter against the SHARED protocol subset
(prompt/steer/abort/get_state + message/turn/tool events), pick the binary per
config. pi first on the fleet (Node runtime, simpler events, queue_update is a
gift for the queue UI); omp opt-in where its tool harness (LSP, hashline)
earns its Bun dependency.

## Probe artifacts

Scratchpad (session-local): omp-probe/rpc-probe.mjs — spawn/send/log harness.
Re-run: `source ~/.fny/secrets/env.sh && node rpc-probe.mjs rpc fireworks/kimi-k3`.
