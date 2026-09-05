# App scenario scripts

Reproduction scripts written by Codex (gpt-6-astra) while reviewing waves 2–3
(2026-09-05). They import the REAL app modules (sync methods, stores, row
factories, the read adapter and crypto) and drive controlled interleavings —
a lost acknowledgement, an edit during a pending send, a superseded diff fetch.
Run one from `packages/joy-app`: `npx tsx test-scenarios/<file>.mts <scenario>`;
scenario names are the `scenario===` literals inside each file. Scripts from a
review round assert the ORIGINAL bug (an AssertionError means it is gone);
follow-up rounds assert the intended behaviour and print `"result":"fixed"`.
Candidates for conversion into vitest specs.
