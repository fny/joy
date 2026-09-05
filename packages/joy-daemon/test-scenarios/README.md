# Lane scenario scripts

Reproduction scripts written by Codex (gpt-6-astra) while reviewing the durable
outbound spool (wave 1, 2026-09-05). They drive the REAL nucleus lane, spool and
RelaySession against a mocked relay with controlled interleavings (blocked
POSTs, lease fencing, boot/sweep ordering, failed disk writes), which the unit
suite does not cover.

Run one scenario from `packages/joy-daemon`:

    JOY_HOME_DIR=$(mktemp -d) npx tsx test-scenarios/lane-third-followup.mts <scenario>

Scenario names are the `scenario===` literals inside each script. The earliest
scripts (`lane-spool.mts`, `lane-followup.mts`) assert that the ORIGINAL bug
reproduces — an AssertionError from them means the bug is gone; the later ones
(`lane-second-followup.mts`, `lane-third-followup.mts`, `lane-multi.mts`) assert
the intended behaviour and print `"result":"fixed"`.
