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
