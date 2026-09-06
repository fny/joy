# Review campaign, September 2026 — final plan

Status: adopted 2026-09-06. Owner: Faraz (decisions, deploys). Executor: Claude
(Fable) with Codex Astra as reviewer. Tracker: GitHub issues on fny/joy, labels
`area:*`, `sev:*`, `found-by:*`.

## Where we start

| Bucket | Count |
|---|---|
| Open issues on 2026-09-06 | 605 |
| Pre-coverage issues still open (#2–#131): fixed by waves 0–4 but never closed / still live / design follow-ups | 44 / 66 / 5 |
| Coverage findings in wave-rewritten files re-verified: still present / already fixed | 108 / 12 |
| Coverage findings filed as #132–#621 | 490 (11 more were duplicates of earlier issues) |
| Coverage severity: high / medium / low | 26 / 346 / 129 |
| Coverage area: app / daemon / relay | 343 / 142 / 16 |

Waves 0–4 (2026-09-04/05) fixed the first 131 issues' critical set: crashes and
corruption, the durability contract between daemon and relay (outbound spool,
`fateOf`, sweep release, spawn intents), lifecycle and adapter honesty, the app
correctness batches, and the paging/polling/diff performance items. Nothing has
been deployed since the 2026-09-04 rollout; the relay must deploy before the
app for `events?before=`.

## What the findings have in common

Both reviewers read the 501 coverage findings for root causes. We agree on the
diagnosis: the same operation is judged accepted, delivered, cancelled,
persisted or obsolete by several layers independently, and each layer has its
own answer. Roughly 160 findings are ~15 recurring patterns; the remaining
~340 are individual logic bugs clustered by module.

Recurring patterns (approximate counts, verified when each sweep starts):

| Pattern | Findings | Correction |
|---|---|---|
| A failed write or one bad record erases the previous good state; success acknowledged before durable | ~28 | atomic write + ack-after-commit on daemon/relay; "isolate the bad row" in app stores and decryptors |
| A late or cancelled async result overwrites a newer one | ~20 | request generation / latest-wins (the #91 pattern), then a resource-owned query slice (E4) |
| Tool results interpreted per view: null guards, error shape, failure shown as success | ~25 | one canonical tool-result model at ingestion (E1) |
| Floating promises / unhandled rejections | ~12 | `no-floating-promises` as a lint error + one guarded-async helper |
| Unbounded regex or diff work on the UI thread | ~8 | work budgets at the render boundary with plain fallbacks |
| Timers, listeners, subprocesses outliving their owner | ~8 | lifecycle scope primitive (task scope with cancellation) |
| Clipboard reports success on failure | ~8 | one clipboard helper |
| Plain-object lookups keyed by user data (`__proto__`) | ~8 | `Object.hasOwn` / Map |
| Shell / XML / plist quoting | ~7 | one quoting helper per target |
| Parser input trimmed | ~6 | stop trimming |
| Chunk-split UTF-8 / CRLF decoding | ~5 | `StringDecoder` + line buffer helper |
| Git paths quoted by `core.quotepath` | ~5 | parsed once, daemon-side (E2) |
| `CODEX_HOME` ignored | 3 | one resolver |
| Fixture "proofs" and dev screens | ~22 | proofs become vitest; dev screens closed as won't-fix |

## Architectural changes we will make

Ranked by payoff per unit of risk, merged from both reviewers' notes (Astra's
full note is beside this file: `review-campaign-2026-09-astra-architecture.md`).

1. **Structured repository data from the daemon (E2).** The daemon parses git's
   machine formats once (porcelain v2 `-z`, NUL numstat with the two-path
   rename form, structured refs) and returns a versioned response: root,
   session-relative relationship, branch/detached/unborn, exact path identity
   separate from display text, index/worktree/conflict state, rename
   source/destination, binary flag, explicit available/unavailable line counts.
   The app's `sync/git-parsers` and the numstat/porcelain consumers in
   `gitStatusFiles.ts`/`gitStatusSync.ts` are deleted after a compatible
   rollout. ~30 findings. Bounded, low risk. Do now.
2. **Canonical conversation and tool model (E1).** One versioned tool-call
   model at adapter ingestion and at the app's legacy-record boundary: stable
   session/turn/call identity, validated arguments, explicit outcome
   (failed / cancelled / denied / succeeded), ordered result blocks, optional
   structured command or file-change data, raw fallback preserved. Views
   become presentation-only. The order-sensitive reducer paths become an
   identity-based projection: unmatched results retained until their call
   arrives, subagent children keyed by call identity, duplicate live/history
   observations merged idempotently, historical lifecycle events never
   overwrite the current snapshot. ~35 findings incl. the crash class. Ship
   the result/error contract first, then the projection. Do now.
3. **Durable acceptance ledger in the daemon (C1).** Replace `queueStore`,
   `receipts`, adapter inbound/checkpoint files, `outboundSpool` and the
   execution-relevant part of window records with one SQLite store
   (`node:sqlite`, WAL + `synchronous=FULL`, short transactions) behind a
   transactional API: accept command, record dispatch attempt, record runtime
   observation, acknowledge outbound event. Acceptance is returned only after
   commit; `requireDurable` stops being the caller's choice. Command id,
   payload version, session generation, runtime attempt id and event sequence
   stay distinct; confirmed sequences live in a retained receipt table even
   after the pending row is gone. One outbox scheduler sends in persisted
   order and retries by stable event id. Versioned one-time import of the old
   files, no indefinite dual writing. ~30 daemon findings incl. seven highs.
   Wave A closes the highs first with an atomic-write helper so they do not
   wait on the ledger; the ledger then removes the class.
4. **Session coordinator (C2).** Extract the execution policy from the five
   adapters into one daemon `SessionCoordinator`: durable command states
   (queued → submitting → accepted/unknown → running → terminal), a generation
   per session replacement, an attempt id per submission, cancellation as a
   durable requested transition retried until confirmed or explicitly
   unresolved. Adapters become drivers (submit, interrupt, observe,
   reconcile) and keep protocol buffering only. `nucleusLane` translates relay
   offers into coordinator operations; CLI sends and handoffs use the same
   operations. Serialize state transitions, not I/O (operation token +
   generation check on completion, never a lock held across a submit).
   Capability differences stay explicit (OpenCode steer, Claude terminal
   draft, Codex ambiguous submission). Port Codex and local send first, replay
   the failure-order harnesses, then the other drivers. ~25 findings and the
   source of the #77/#78 residual churn. Do after the ledger boundary exists.
5. **Lifecycle scope and bounded I/O primitives (B).** A task scope per session
   generation / connection / resource owning children, timers and
   subscriptions; bounded subprocess and stream helpers (deadlines, complete
   frame identity, streaming text decoding, byte limits, drain-aware writes,
   process-group aware shutdown). Introduced while the families are swept.
6. **Parse and render budgets (B).** Size/depth/work limits at the rendering
   boundary with safe plain-text or whole-line fallbacks; Joy tags recognized
   only in parsed context so code examples stay literal.
7. **Resource-owned queries for files, git, session lists and pickers (E4).**
   Keyed by real resource identity (machine, repo/session, path, options,
   revision); a request writes only its resource cache; error, authoritative
   empty, unavailable and last-good are distinct states. Bounded to that
   cluster; the conversation reducer and unsent user intent (drafts, sends,
   attachments) stay out of it. Go/no-go after the file/git slice.
8. **Structured Claude runtime: spike only (F).** One-day feasibility check of
   a managed runtime with identified input and structured observations,
   against the terminal-parity requirement (independent typing, slash
   commands, drafts, resume). Until it proves command identity, input
   arbitration, interruption and recovery, the pane parser is repaired per
   finding and uncertain pane evidence is treated as unknown.

Not doing: microservices, event sourcing for preferences, a new git engine,
replacing the relay's PGlite core (fix its exclusive data-directory ownership
instead), an app-wide fetch rewrite beyond the E4 slice.

## Waves

Each wave: implement → Astra verifies against reproductions (≤ ~30 items per
round) → fix residuals → Astra re-verifies → commit and push to main. Files
Astra's gate refuses (relay `auth.mjs`, `gate.mjs`, `tokens.mjs`,
`tunnel.mjs`, daemon `src/tunnel/`) are reviewed by a Fable subagent instead.
Astra's reproduction scripts are converted to vitest as each wave lands so the
regression harness grows with the fixes. Every user-visible app change goes in
`packages/joy-app/CHANGELOG.md`; `docs/FEATURES.md` and `docs/API.md` follow
any op change. No deploy without Faraz's go; deploy order is relay → daemons →
app.

### Wave 0 — bookkeeping (no code) · done 2026-09-06
- Verified each of the 115 open pre-coverage issues against main (Fable
  subagent, code inspection per issue): 44 fixed → closed with the commit;
  66 still live → folded into the waves below; 5 design follow-ups
  (#127–#131) stay open.
- Re-verified the 120 coverage findings whose files the waves rewrote: 12
  fixed → closed; 108 still present.
- The 66 live pre-coverage issues join their families: the Claude dispatch and
  steer family (#30–#40, #110) → C3 with the pane parser; tunnel plane
  (#82–#84, #119) → A1/D; `transports/v2.ts` write and decode (#62, #63) →
  A2/B; agy and restart gaps (#49–#53) → C3; voice (#20–#25, #101) → E7;
  security-flavoured lows (#48, #54, #94, #107, #118, #120) → A1/B; the rest by
  module.
- Exit: the tracker only lists live defects and designs.

### Wave A — the 26 highs (~2 days) · deploy checkpoint 1
- **A1 trust boundary (7 + 1 footgun):** sealed sessions accepting plaintext
  prompts; killed-session spool replay exposing plaintext; sealed tunnel
  response replayable to another request; body identifiers redirecting v2
  ops; search/diff arguments escaping the file jail; git path validation
  following a tracked symlink; stale daemon PID killing an unrelated process.
  Fable review for the tunnel/auth files.
- **A2 durable-write family (9):** shared atomic write helper (tmp + fsync +
  rename, verify on failure) and ack-after-durable: agentConfig backup,
  fileOps save, queueStore, v2 file write with bad base64, local send ack,
  handoff ack, concurrent clone deleting the working copy, recovery binding a
  fresh Claude to an old transcript, relay concurrent db opens (exclusive
  data-dir ownership).
- **A3 identity/recovery and app highs (10):** codex history ids reusing
  canonical identities; dedup forgotten after the echo; dispatch after failed
  persistence; agy advancing before stdout closes; singleton lock reclaim;
  failed old dispatch overwriting the replacement queue. App: cleanup deleting
  live sessions / killing a restarted one; git-URL creation never cloning;
  teleport ignoring the chosen permission mode; failed permission change
  persisted; terminal keyboard interleaving; static render importing
  browser-only theme code.
- Exit: Astra sign-off on all 26; suites green; deploy checkpoint offered.

### Wave B — family sweeps (~3 days)
- Lint: `@typescript-eslint/no-floating-promises` as an error in all three
  packages; fix the sites.
- Helpers: guarded async, clipboard, quoting (shell / XML / plist), chunk-safe
  decoding, `CODEX_HOME` resolver, `hasOwn` lookups, stop-trimming, parse
  budgets, lifecycle scope + bounded subprocess/stream helpers.
- Latest-wins generation tokens at the ~20 stale-result sites (kept where E4
  does not later own the resource).
- "Keep the last good value / isolate the bad record" at the app store and
  decryptor sites.
- Exit: each family has one helper, one test, zero remaining sites (grep).

### Wave C — daemon (~6 days)
- **C1 ledger** (architecture 3): acceptance + receipts + outbound first,
  then adapter inbound/checkpoints, then window-record execution state.
  Import old files once; crash-recovery tests at every boundary.
- **C2 coordinator** (architecture 4): extract with Codex + local send, replay
  the wave-3 harnesses, migrate OpenCode, pi, agy, Claude.
- **C3 modules:** Claude pane parser (six detection findings, live-capture
  tests), transcript watcher trio, usage quartet; cli (10), transports (11),
  tmux (6); remaining domain items (limits, envStore, resourceAlerts,
  attachments, forkHarness).
- Fixture proofs converted to vitest or deleted.
- Exit: Astra sign-off per sub-wave; `pnpm typecheck && pnpm test` green.

### Wave D — relay (~1 day) · deploy first
- Archived session resurrected by a late turn start; exhausted sessions still
  accepting prompts; delayed spawn failure disabling a bound retry; SSE
  greeting heartbeat leak; queue reorder stranding an acked delivery; delete
  interrupting a started turn; pairing sweep deadline; Expo stall; attachment
  orphan deadline; consumed credentials on a lost pairing response; docs/notify
  lows.
- Exit: `npx vitest run` green; Astra sign-off; relay deploy offered before
  any app deploy.

### Wave E — app (~8 days) · deploy checkpoint 2 after E2
- **E1 sync core + canonical model** (architecture 2): sync.ts, storage
  permission-mode quartet, settings/localSettings isolation, ops.ts, reducer
  projection, typesRaw, sessionEncryption, spawn retries, CRLF streams.
- **E2 structured git** (architecture 1): daemon endpoint, app consumers,
  delete `sync/git-parsers`.
- **E3 tool views** on the canonical model: crash-class first, then
  failure-shown-as-success, then per-harness views (Codex patch/bash/diff,
  Gemini, Task, Bash/Edit/MultiEdit full views).
- **E4 query slice** (architecture 7): FileViewPanel, AllFilesDiffView,
  prefetch, git status, machine env, session lists, pickers; remove the
  duplicate cache writers; go/no-go for wider use.
- **E5 markdown and link parsers**, **E6 settings / auth / cleanup / modal /
  navigation**, **E7 voice and sound wake** (needs a device), **E8 file panel,
  drawing, remaining components**.
- Exit: Astra sign-off per sub-wave; app suite green from the package dir;
  CHANGELOG entries per user-visible change.

### Wave F — lows, won't-fix, spike (~2 days)
- Remaining lows ride with their module; the won't-fix bucket is closed with a
  one-line rationale each.
- Claude structured-runtime feasibility spike (architecture 8) with a written
  stop/go.
- Exit: every coverage issue is closed as fixed, won't-fix, or converted to a
  design follow-up; a final summary in this file.

## Progress log

- 2026-09-06 — Wave 0 done (56 closed). Wave A landed (53d22103 fa8d6de5
  ddc89de1 40873bd6 9d5c53c9 372f7d54 + residual rounds); 19 highs verified
  and closed; tunnel binding reviewed by a Fable agent, which also found and
  fixed request replay to the daemon (9a38bc61). Both single-owner locks
  (daemon singleton, relay data dir) became SQLite `BEGIN IMMEDIATE` locks
  after four file-protocol rounds each still had a takeover window
  (0a0db1cd, 7c973766). Wave B merged as three branches (da868c80 daemon,
  035ac825 app data, d53685b4 app async); Astra review in progress. Wave C
  design written (`/tmp/joy-test-tmux/review3/waveC-design.md`; decisions:
  Node ≥ 22.13 for `node:sqlite`, identity fields stay in the window JSON,
  7-day retention, new client id per attempt, `/steer` stays fire-and-forget);
  C3 modules in flight; C1/C2 wait behind the Wave A residual merge. Wave D
  merged (relay 79 tests) with daemon/app contract follow-ups in flight.
  Wave E1, E2, E5, E6, E7 in flight as isolated worktree agents.

- 2026-09-07 — Wave D relay merged (79 → 89 tests with the Fable tunnel
  hardening: bounded response buffering, admission before body, relay-wide
  budget) and its daemon/app contracts (request_gone, spawn-failed
  deliveryId, session_archived, retry-after handling, connection_slow). Wave
  E2 structured git, E5 markdown/links, E7 voice merged with What's New
  entries; E1 tool model and E6 settings/auth/modal finished on branches.
  Wave C3 daemon modules finished on a branch. Wave B verified-fixed issues
  closed (65) and the won't-fix bucket closed (22); 446 open. Four merges
  await conflict approval (Wave A residuals, C3, E1, E6). Architecture item
  8 spike done (`review-campaign-2026-09-claude-runtime-spike.md`): STOP on
  a headless runtime — a Claude session id is single-process and the only
  attach path takes keyboard input only; GO on hooks + transcript as the
  authority inside the TUI (SessionEnd, PermissionRequest, StopFailure,
  permission_mode…), pane demoted to a tie-breaker.

- 2026-09-07 (later) — Wave E8a (sync core, spawn, encryption, session
  screens; ffe23ad2) and E8b (composer, autocomplete, file viewer, diff, QR,
  utils; 161bdc74) landed with What's New entries; #134's accepted-turn
  cancel followed (f3ea33df). Daemon free-files round (4a69e55c): lane
  outcomes, spawn-failure acks, deleted relay rows, paced event history,
  pairing key, content-free push, CAS metadata, receipts, config paths,
  tunnel path validation and relay key. Wave D residual rounds through
  a80f0aca. Astra reviews queued for Wave E and the daemon round; a Fable
  reviewer on the tunnel executor. Four merges still await approval.

- 2026-09-07 (evening) — Faraz delegated conflict resolution for the
  campaign's branch merges; the four held branches landed: Wave A residuals
  (6d994569), C3 daemon modules (7bfa9248), E1 tool model (6256547c), E6
  settings/auth/modal (4b419100), with union imports/strings, main's diff
  counter kept over E1's, E6's auth files taken. Daemon 775 tests, app 1363.
  C1 ledger, the hooks-as-authority step, E4 query slice and the leftover
  strings are in flight; Astra reviews queued for the daemon round, the
  four merges and Wave E.

- 2026-09-08 — Hooks-as-authority merged (617dc734): Claude hooks v4 drive
  session state behind a per-session live latch; the pane parser is a
  tie-breaker. Residual rounds from Astra's Wave E and daemon-round
  verdicts landed: daemon (b2aa492d, 2e425874), voice (475e5976), parsers
  (70090dd2); sync/encryption and components rounds in flight; E4 query
  slice and the C1 ledger in worktrees.

- 2026-09-08 (later) — Wave E4 merged (cb3d1e95): a thin in-repo resource
  layer (`sync/resource.ts`, `hooks/useResource.ts`) owns git status, file
  contents/diffs, machine env, session lists and pickers; the reviewer's
  go/no-go for wider adoption is GO with two conditions (passive entries
  outside screens; the conversation reducer and drafts stay out). The four
  app residual rounds landed (475e5976 70090dd2 5d816672). C3 residuals on
  claude/session.ts wait for the C1 ledger merge.

- 2026-09-08 (status) — 374 issues open (from 605). Astra's C3 review: 39
  fixed, 18 residuals; the non-session ones landed (bf92eb57), the
  session-file ones wait for the ledger. C1 ledger branch at 7 phase
  commits (store, Claude queue + receipts, outbox scheduler, Codex/OpenCode
  inbound + checkpoints, window-record execution fields + spawn intents +
  handoff jobs, pi/agy queues, one-time import).

- 2026-09-08 (C1) — The durable acceptance ledger merged (95c4781e):
  `src/domain/ledger.ts` (SQLite WAL+FULL, transactional API), the relay
  outbox (`src/relay/outbox.ts`, one sender per session), Codex/OpenCode
  inbound + checkpoints, window-record execution fields, spawn intents,
  handoff jobs and pi/agy queues on the ledger; queueStore, receipts,
  outboundSpool and the codex stores deleted; one-time import of the legacy
  files at boot. Daemon 812 tests. Left for C2: real running/terminal
  outcomes, cancelling/unresolved surfacing, idle-without-terminal →
  interrupted, relay_turn_id plumbing, `/steer`.

- 2026-09-08 (C2) — The session coordinator (`domain/coordinator.ts`,
  branch c2-session-coordinator): pure `nextState` table over the ledger's
  ten states (exhaustively tested), op tokens that serialize transitions
  not I/O, one driver op per session, a rejection budget read from attempt
  rows, durable cancel retried until confirmed or `unresolved`, foreign-turn
  provenance, idle-without-terminal = interrupted (#463), R18 look-back for
  a turn that ended before its submit response. Drivers: Codex
  (`codexDriver.ts`), OpenCode, pi, agy — their private queues, dispatch
  loops, tombstones, admission ranking and outcome caches are gone; Claude
  waits for the hooks residual merge and runs behind `queueFacade.ts`.
  `operations.ts` send/queue ops, handoff and the nucleus lane go through
  the facade; the lane accepts a relay turn as a command row
  (`relay_turn_id`), posts `/start` on the driver's echo, terminalizes on the
  command's state, cancels through the durable flag, resumes ledger turns at
  boot (R13); `activeTurns`' cancel bookkeeping, the 180 s activity gate and
  the registry's turn canceller are deleted. Deviations recorded: the echo
  now means `running` and `completed` comes from the runtime's turn end
  (C1's "delivered = completed" is gone); `exclusive` send refuses on a
  non-empty queue, not only on busy; the deterministic `codex-in:<id>:<seq>`
  ids are dropped (attempts/receipts carry ownership); attachment
  materialization stays lane-side, so a cancel during the download aborts
  the preparation rather than cancelling a row; a restart mid-turn closes
  the relay turn `interrupted{restart}` (was `cancelled`).
- 2026-09-09 (C2 phase 5) — Claude on the coordinator
  (`claude/claudeDriver.ts`): the Session keeps the pane gate, the pane-
  writer lease, the confirm paths, the draft preservation and everything the
  hooks round added, and exposes them as a driver — `prepare` (the gate, run
  before the attempt is committed so a waiting row stays `queued`),
  `submit` (type + delayed Enter + the runtime's verdict), `steer`,
  `interrupt` (Escape), turn edges from the hooks with the transcript as the
  tie-breaker. Deleted: the Session's in-memory queue, outcome cache,
  carried set and drain pump; the queue facade's legacy branch and
  `legacyWaitFor`; the lane's `legacyOutcome`/`LegacyWaitEnv`; the
  registry's memory carry; `AgentSession`'s queue methods (the queue is the
  coordinator's everywhere). Deviations: `/steer` is a durable steer command
  (serialized — steers no longer supersede each other); a dispatch timeout
  is a transient, uncounted rejection + `dispatch_timeout` pause (the row
  stays queued, the attempt matchable for a late echo) rather than an
  `unknown` reconciled by the driver; a row typed but not submitted at a
  restart is reconciled `absent` and re-typed by the replacement (it used to
  be cancelled); `accepted` (Enter landed, echo pending) blocks the next pane
  op until the hook/echo lands. Astra's ask: crash-injection lane tests
  (stop after `/start`, boot over the same ledger → one terminal
  publication, no second `/start`; the running variant waits for the
  runtime) in `nucleusLane.coordinator.test.ts`.
- 2026-09-08 (later) — E1 tool-model residuals landed (7ead9a3d); #107
  sealed spawn specs end to end (705ef5f6: the relay holds ciphertext when
  the daemon advertises `capabilities.spawnSpecSealed`). Astra's E6 review:
  57 fixed, 18 residuals in flight; its hooks-authority review left three
  regressions and a partial, folded into the session-file round.

- 2026-09-08 (count) — the verified-fixed closer ran over every wave's
  verdicts: 187 more issues closed; **246 open** (from 605). Remaining
  open: items still awaiting Astra's verdict on residual rounds, the
  session-file residuals in flight, design follow-ups (#127–#131), and the
  lows scheduled for Wave F.

- 2026-09-08 (session round) — Claude session-file residuals and the
  hooks-authority regressions landed (b2274858: flush-left numbered drafts,
  fresh-capture mode verification, evidence-only confirmation, pane-writer
  lease, cancel reset before the first write, local_command bash echo,
  re-fenced draft restore; hooks v5 with end_reason/agent ids, ingress fence,
  subagent events excluded, hook-owned readiness). #31 and #577 are moot on
  the ledger. C2 coordinator started in a worktree; daemon round-two and
  voice round-two residual agents in flight.

- 2026-09-08 (C2 + E residuals) — voice round two (235fb05b: stop awaits
  every recorder release, bounded context ledger retired on hang-up),
  parser round two (87badd7d: options regions parsed once under the budget,
  bare-URL parens in one pass, quoted filenames as one link) and the E8
  residuals (1eee9592: persisted spawn intents wired through both retry
  paths, versioned AES carrier, post-dispatch terminal failures are
  unknown, sodium byte ownership at card/spawn-spec, picker latch gone).
  Wave C2 phases 1–2 merged (341b615b: `src/domain/coordinator.ts` with
  the R1–R20 state table, Codex driver, `queueFacade.ts`); phases 3–4
  (lane, OpenCode/pi/agy drivers) continue in the worktree; the Claude
  driver waits for the hooks residual round (617dc734 regressions:
  subagent identity, ingress fence, SessionEnd contract, hook-owned
  readiness). Astra's C-round partials #120/#587/#61/#597 were already on
  main (6c737d7b, 057f8012); only a docs note landed (85e9fd7f). E4 query
  layer review: 20 issues verified fixed; three contract regressions
  (trailing versions, removal ownership, budget reclaim) plus the file
  mutation ordering, ops retry classification, machine-read four-state
  adapters, git projections and stray catalog/probe reads are in three
  parallel residual rounds. New low: #622 parseTable quadratic.

## Won't-fix criteria

An issue is closed as won't-fix when it is low severity and all of: no data
loss or exposure, no crash, no wrong state persisted, and one of — developer
or demo screen only (`app/(app)/dev`, kitchen, modal demo, palette controls,
QR demo, test runner), Windows-only path semantics on a product that does not
ship a Windows daemon, cosmetic label or timestamp display, or a defect in a
fixture script that is being replaced by a vitest test. Roughly 30 of the 129
lows; each gets a comment naming the criterion.

## Dependencies

- Wave 0 before anything, so fixed code is not re-fixed.
- A2's atomic write helper before C1; C1 before C2.
- A3 identity fixes before C2 and the adapter items in C3.
- B before C3 and E, so per-module work does not re-fix pattern bugs.
- E1's canonical model before E3; E2's daemon endpoint deploys before the app
  consumers drop the parsers; D deploys before E2's app side.
- Nothing ships without explicit permission; checkpoints after A, after
  D + E2, and at the end.

## Exit checks that apply to every wave

Crash recovery at each persistence boundary; a late callback after a
replacement never writes into the successor; a lost acknowledgement followed
by a retry produces one command; conversation projection is identical under
reordered history and live events; no new `void promise` without a handler.
