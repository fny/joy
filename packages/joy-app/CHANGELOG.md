# Sep 8 (3) — Review follow-ups

- **Full sessions**: a session whose relay budget is used up shows a persistent warning in the chat and a marker on its sidebar row, counting the output that could not be saved and since when, with a Start a new session action; the daemon remembers the loss across restarts, and no notification is needed to see it.
- **Cleanup**: deleting a folder's session records asks the relay to refuse any record whose session is still running at that moment, so a session that restarted while the confirmation was open keeps its record and is reported instead of being deleted under a live agent.
- **Changes and files**: a failed git status check shows an error with Retry instead of "not a repository" or "no changes", stale results carry a retry line, an edit or refresh that arrives while a read is running is fetched once more instead of being lost, and a slow save acknowledgement can no longer overwrite a newer save.
- **Starting sessions**: a session whose creation the relay never confirmed is remembered until it is confirmed or refused, across app restarts and however long later; retrying offers to re-send the same request so at most one session starts. The new-session machine picker re-probes when the machine list changes during discovery instead of leaving nothing selected.
- **Terminal**: a send whose reply was lost is treated as possibly landed, so a retry clears the input line first instead of typing the text twice.
- **File viewer**: the file screen shows what is in the shared file cache, so a save made in the file panel appears there at once, a file the daemon reports as unchanged loses its stale diff, and a refresh that fails keeps the last loaded version on screen with a notice instead of an error. Inline chat images read through the same cache as the file viewer.
- **Tool cards**: a command previews the same way everywhere — the card header, the group row, the Task child row and the detail header — whether it is running or done: a compound Codex command stays whole, a Gemini shell condition keeps its brackets, a heredoc shows its opening line, and a very long command is cut with an ellipsis instead of overflowing. Opening a tool card from a group row or a notification finds it after a restart too, including cards nested inside a Task.
- **Chat history**: a message that could not be decrypted is kept as a gap and read again once the session key is corrected, instead of being skipped for good. The chat now shows a "could not decrypt N messages — will retry when keys change" row where those messages belong until they open, an older page that fails while scrolling up is kept as a gap too, and a long gap is re-read across several syncs instead of being forgotten after its first five pages.
- **Drawing pad**: a quick two-point flick draws a line instead of a dot, a second finger touching the pad no longer hijacks or drops the stroke in progress, and resizing or rotating the pad keeps annotations on the part of the screenshot they were drawn on.
- **Paths**: on Linux a tool path that differs from the session folder only by letter case is no longer shortened as if it were inside it, and a home directory that is a filesystem root keeps its separator.
- **Performance**: a message with many leading blank lines, or a long run of pipe-separated lines that is not a table, no longer stalls the app while it renders.
- **Restore by QR**: the device showing the code now proves it holds the code's private key before the relay hands it the account, so someone who merely saw the code cannot collect the sign-in first. Relays from before this change keep working as they did.

# Sep 8 (2) — Review follow-ups

- **Voice**: the idle listener rotates its recording every five minutes instead of growing one file; a session that finishes while voice is still connecting is reported once connected; ending a call while it is connecting always wins.
- **Markdown and files**: an unfinished options block no longer swallows the text after it, links with nested or escaped parentheses open correctly, a capped Mermaid diagram stays scrollable, a remote image is loaded only for the URL you tapped, quoted paths with spaces link as one file, and CSV previews report truncation only when rows were actually left out.
- **Sending and history**: resetting a chat during a fetch, forgetting a session deleted elsewhere, or sending into an evicted session can no longer let an in-flight page write stale rows; a session created after a lost response is reused on retry instead of duplicated; removing a queued draft cancels exactly the send it belongs to, and an edited draft is never removed by the old send.
- **Composer**: dismissing suggestions with Escape is tied to where you were typing, search reveals matches inside nested work groups and scrolls to the hit itself, and the phone return key applies a suggestion without a stray newline.
- **Tool cards**: results that arrive before their call settle into the right nested row, Task details show the subagent's conversation and every answer part, Codex read/write details show partial output and warnings, and a running edit is no longer summarised as done.
- **Settings and sign-in**: push registration attempts are bounded, config drafts belong to one file, offline machines drop off the list when their lease ends, logging out fully stops the previous account's sync, relay slots keep the right owner's credentials, and browser Back/Forward track the router's own entries.

# Sep 8 — Files and git, one source of truth

- **Git status, file contents, diffs, machine environment keys, session lists and the new-session pickers now come from one shared cache per resource.** A late or cancelled request can no longer overwrite a newer answer, a failed refresh keeps the last good data instead of blanking the screen, and the same file or repository is never fetched twice in parallel.
- **The file viewer detects an external change from the resource itself**: reverting the change on disk clears the warning, Reload always installs what is on disk, and a file emptied on disk shows as empty.
- **Diffs in the Changes view refresh when a file's contents change**, even when its status and line counts did not, and a failed read shows Retry.

# Sep 7 (5) — Tool cards, settings and sign-in

- **Tool cards read one record.** Every card, detail screen and group summary shows the same outcome for a tool call, failed, cancelled, denied, running or done, across Claude, Codex, Gemini and pi sessions. Failures show their reason: no more "[object Object]", an ordinary tool error is no longer drawn as a cancellation, and a failed edit or patch is labelled as a proposal with the failure next to it.
- **Nothing valid is dropped**: multi-part results keep every part including images, a zero or empty result is shown rather than treated as missing, and a result that loads before its call is attached when the call arrives. Two Task calls in one message keep their own output; a subagent's pending approval resolves everywhere it is shown; approvals are never hidden inside a collapsed patch.
- **History stays history.** Loading older messages no longer switches the session into plan mode or clears another session's saved permission choice. Group summaries count files touched and say when something failed or awaits approval; manually expanded groups stay open.
- **Logging out no longer hangs offline**; a login that could not be removed from the device is reported. Turning Mobile push off removes this device's token from the relay, and interrupted token replacements no longer leave the old token registered.
- **QR login keeps waiting through a network blip**, shows one clear reason when a code was used or expired, and cannot sign you in behind the secret-key screen; manual restore no longer uppercases typed keys. Gated relays: device approvals and terminal pairing carry the relay key, and switching to a gated relay uses its saved key or asks for one.
- **Dialogs never leave an action stuck** (Escape, programmatic dismissal, startup dialogs); only the top stacked dialog is shown and a prompt underneath keeps its draft. Command palette: no premature Enter during Japanese or Chinese input, it reopens reliably, and it gives Ctrl+K back to the browser when disabled.
- **Machines and the daemon row go offline when they stop reporting**; environment-key failures show an error row with Retry; updates never overlap and rollback releases apply; the What's New dot clears everywhere at once.
- **Agent Defaults stop offering Claude models to OpenCode, pi and Antigravity**; the config editor keeps unsaved edits and can retry; usage totals and machine deletion report partial failures instead of hiding them; project logs and deep links load correctly right after launch; history date headers are right across daylight-saving changes.

# Sep 7 (4) — Composer, files and small fixes

- **Dropping or pasting images into the web composer attaches them reliably**; an image copied together with text no longer dumps the text into the box.
- **Escape closes the autocomplete, and a second Escape stops the running turn.** File autocomplete keeps working after a dot (`@src/file.ts`), completing before an existing space puts the caret after it, and on phones the return key applies the selected suggestion instead of adding a newline.
- **An answer option that fails to send shows the error and keeps the answer as a draft.**
- **File viewer**: SVG, WebP and AVIF render; the "changed on disk" warning clears when the change is reverted; Reload always installs what is currently on disk. The Changes view refreshes diffs when contents change and shows Retry on a failed read.
- **Search reveals matches inside collapsed work groups.**
- **QR codes use standard square finders and stay scannable on transparent backgrounds.**
- **Diffs recover after an offline first load** instead of staying blank; resume commands quote paths with apostrophes and never run in the wrong directory when `cd` fails; returning to a web tab keeps your chosen theme and palette.
- **Leaks fixed**: downloads and shares remove their temporary files; rejected picker files and failed previews release memory.

# Sep 7 (3) — Sync and sending, made durable

- **Sessions deleted on another device disappear on the next refresh** instead of lingering, and reloading a chat during a fetch no longer strands its history behind one message.
- **A send whose response was lost after the relay accepted it stays in the chat**, and sending into a session the app had evicted from memory no longer hides its older history.
- **Starting a session after a dropped connection no longer creates a duplicate**, startup no longer hangs when the relay stops answering after accepting, and a long-open "Create directory?" prompt no longer reports a false failure.
- **Queue actions report daemon failures**; steering or removing a queued message can no longer lose it or leave a ghost send; clearing the composer no longer restores the saved draft.
- **Approving or denying a tool request reports failure when the daemon did not apply it**, and renaming a machine cannot overwrite concurrent updates after a decrypt hiccup.
- **Settings written by a newer app version are preserved** instead of being stripped and synced back.
- **Terminal: failed sends put your text back**, and the window size is retried once the daemon is reachable. Attachments survive resizing across the sidebar breakpoint, session search keeps its place when matches change, and the model chip on Codex, pi and Antigravity sessions no longer types into the terminal.
- **Live updates no longer stall** when the relay's event stream splits a line ending across chunks.

# Sep 7 (2) — Git status and Markdown, exact

- **File names are shown exactly as they are** (trailing spaces, quotes, pipes, accents, emoji); the file you see is the file that opens. Line counts are exact or absent: binary, untracked and unread files show no number instead of 0, and a failed read no longer wipes known counts. *Needs the updated daemon for exact names and counts; an older daemon still lists files without them.*
- **Renames, conflicts and states read correctly**: renamed files show the new name with the old alongside, add/add and delete/delete conflicts are listed as conflicts, a rebase in progress or a linked worktree is reported as such, and a file deleted in the index but recreated on disk can be opened again from Changes.
- **Git refreshes retry after a dropped connection**, and a closed screen's late refresh no longer overwrites a newer one.
- **Markdown tables and fences behave**: escaped pipes stay in one cell, two tables separated by a blank line stay two tables, a four-backtick fence can quote a three-backtick example, and an inline options block no longer swallows the text after it.
- **Links with parentheses open the full address**; Mermaid diagrams size to their content on phones and several diagrams in one message no longer overwrite each other.
- **Remote images in agent replies load only when tapped**, and the code-block Copy button is available on phones and tablets.
- **File references link correctly**: `/repo/a.ts and /repo/b.ts`, `index.ts:12`, quoted paths, `file://` URLs and `~/…` paths.
- **Task notifications that arrive with a prompt no longer hide the prompt**; slash commands keep their arguments when mixed with other text.
- **Codex diffs keep `--`/`++` lines, name deleted files correctly and show final-newline-only edits**; the +/− badges are accurate. CSV previews scroll vertically and preserve quoted empty records and carriage returns; the rendered HTML preview works on iOS.

# Sep 7 — Voice, steadier

- **Voice's idle listener learns the room before waking**, so steady background noise no longer reopens the conversation over and over.
- **A failed voice start shows once in the status strip** instead of alerting on every sound; tap to retry.
- **Ending or closing voice while it is still connecting really cancels it**, and when you ask Joy to end the call it stays ended.
- **Voice no longer announces approvals you already answered in the app**, and stops replaying old events after a long idle.
- **Sound wake no longer leaves recordings in the app cache.**
- **The composer shows Send, not the microphone, when only an image is attached.**

# Sep 6 (3) — Reliability sweep

- **"Copied" now means copied.** Every copy button — session ids, commands, code blocks, the machine id, the update id, session metadata, the secret key — checks that the clipboard actually took the text. A refused write shows an error instead of a checkmark over an unchanged clipboard.
- **Failures are shown, not swallowed.** A palette command, a button action, an environment-key load or delete, a link or store page that would not open, and a failed older-history page used to vanish into the console. They now report what went wrong; a dialog button that runs an async action keeps the dialog open until it finishes and shows the error in place, with the buttons back for a retry.
- **A late answer never overwrites a newer one.** Switching files while one was still loading or saving, changing machines while an environment or session list was on its way, replacing a drawing background mid-load, deleting a push token during a refresh, backgrounding the app mid-unlock, or typing past an `@` suggestion request — the older result is dropped instead of replacing what you are looking at now.
- **Voice reconnects to the session you are on**, not the one you were on when the line dropped.
- **Turning voice off while the browser is still asking for the microphone releases it** instead of listening on afterwards, and restarting the sound detector no longer leaks an audio context.
- **Nothing keeps running after you leave.** Voice-bar animations, the version tap counter, autocomplete retries and the modal demo's delayed alert all stop with their screen; a live-stream reconnect scheduled just before a stop no longer opens a second stream.
- **Cancelling the QR scanner on Android** is treated as backing out, not an error.

# Sep 6 (2) — Safety fixes

- **A permission mode change shows only once the machine confirms it.** Picking Plan while the change failed used to display Plan while prompts kept running under the old mode — across refreshes and restarts. A failed change is now reported, and the shown mode follows what the agent is actually in.
- **Cleaning up a folder stops its running sessions first.** Deleting a folder's session records left live agents working with no history behind them. Running sessions are stopped and confirmed stopped before their records go; a session that cannot be stopped keeps its record, and the dialog says so.
- **Detached-session cleanup leaves a restarted session alone.** The list is re-read after you confirm, and each session is checked with its machine right before it is closed.
- **Teleport honours the model and permission mode you pick.** The screen sends what it shows, hides the options a teleport cannot apply, starts from the source session's settings, and delivers an initial prompt after the session lands.
- **Terminal sends no longer interleave.** Pressing the keyboard's Send while a previous message was still landing could merge two messages and press Enter twice. One operation at a time now; your text stays in the box until it can go.
- **A machine's answers are tied to the request that asked.** A reply recorded for one request can no longer be passed off as the answer to a later one. *Needs the updated daemon — replies from an older daemon are refused.*
- **Starting a session from a Git URL asks the machine to clone it** into `~/Workspace/<repo>` before launching. *Needs the updated daemon; an older daemon ignores the URL.*
- **The web build's static HTML export no longer fails** on a theme listener that needs a browser.

# Sep 6 — Review fixes

- **A chat you return to keeps updating.** Going back to a session that stayed open under another screen could leave it frozen: the app had stopped treating it as the one on screen, so it no longer polled. Focus now decides which session is live.
- **Scrolling up reaches all of the history.** A long run of invisible bookkeeping rows could make the app decide there was nothing older even though the relay said there was; the page bound now advances through them.
- **Drafts send once.** Tapping Send twice on a saved draft before the relay answered sent it twice.
- **Diff views with very long lines stay responsive**: paired long lines are shown whole instead of computing a word-by-word highlight that took seconds.
- **The all-files diff never shows a stale result** for a file that was cleaned and changed again while an earlier fetch was still running.

# Sep 5 (5) — Faster chat loading

- **Opening a long session is fast again, and scrolling up costs one request.** Loading older messages used to re-read the whole conversation from the beginning every time; the relay now serves pages backwards. *Needs the updated relay first — an older relay ignores the new page request.*
- **Only the session on screen polls.** The app polled every session in the account every 2.5 seconds, decrypting everything and undoing the memory limit; now only the visible session (and one with a send still settling) does.
- **Edit cards with very long lines no longer freeze the app** while their diff is computed.

# Sep 5 (4) — App fixes, second batch

- **File search and `@` mentions return results again** — the file list used a search call the machine rejected, so every session's Files search and autocomplete were empty.
- **"No connection" means no connection.** The banner used to appear on cold start and never when the network was actually gone. It now shows after three failed polls and stays quiet while connecting.
- **Files with accented or non-Latin names open** from tool rows and file lists (the path encoding threw on anything beyond Latin-1).
- **Diagrams can't run code**: a Mermaid block containing `</script>` escaped its container on iOS/Android; it is escaped now and unexpected messages from the diagram view are ignored.
- **Android sheets show every button** (the attach sheet hid Draw and Cancel; agent and model pickers hid most entries) and can be dismissed.
- **Git line counts are back** on session rows and the files sidebar (+N/−N were blank for every session); renamed files show under their new name; **unread markers no longer vanish** while you type a draft or when machines refresh.
- **The usage screen's per-session table loads** (it asked the machine for a route that didn't exist).
- Smaller: New-session Create no longer sticks disabled when a machine's model catalog can't be fetched yet; an empty file opens as empty instead of "Failed to read file"; the effort chip on Codex sessions no longer types a Claude command into Codex; drafts save when you leave the screen, not on every keystroke. *Some need the updated daemon.*

# Sep 5 (3) — App fixes, first batch

- **All Files, per-file diffs and diff prefetch work again.** They were calling a shell path the machine never served, so every repo showed "No files in project" and every diff said "no response". They now use the machine's git routes directly; no shell is involved, so a file name with quotes or `$(…)` can't run anything either.
- **Re-sending after a lost response no longer queues the prompt twice.** A message keeps one idempotency key until the relay accepts it.
- **Stop works for every running turn**, including ones started from the terminal or by another session — it used to do nothing for those. Failures now shake the button instead of vanishing.
- **Drafts survive a failed send** ("send now" kept deleting the draft before the send was known to succeed). A message whose send fails after you left the session is kept as a draft instead of lost.
- **AskUserQuestion answers reach the agent**; before, the card flipped to "submitted" while nothing was sent.
- Renamed files show under their new name in git status. The all-files diff overlay no longer loses files that changed while it was loading. *Needs the updated daemon.*

# Sep 5 (2) — Machine fixes: restart, kill, recovery

- **Restart works on a session whose agent has died.** The first Restart of a red "detached" card used to fail and archive it. Two Restarts tapped at once no longer kill each other's replacement; restarting before the first message no longer archives the card.
- **Killing a detached session actually kills it** — tmux server, record and card go away, instead of a silent "ok" that left a ghost to come back on the next boot.
- **pi sessions survive a machine restart** and resume their conversation like Antigravity and Codex ones do.
- **A dead agent is detected within a minute** even when its frozen screen still looks alive.
- **New sessions never revive an old one by accident.** `joy run` / `joy new` and a request for a different agent, model or permission mode in a folder with a detached session start fresh; `joy run` no longer deletes someone else's conversation on the way out.
- **Re-pairing keeps the sealed provider keys readable.** A machine re-paired with `joy auth` lost access to its `joy env` store for good.
- Machine-side durability from the previous batch (output and turn results survive relay outages and daemon restarts). *All of the above need the updated daemon.*

# Sep 5 — Wave 0 fixes

- **Saving from the desktop file editor no longer corrupts the file.** The editor sent the file's contents base64-encoded without saying so, and the machine wrote that base64 text to disk — while reporting "saved". Both save paths now declare the encoding. If you saved from the editor before this fix, check those files.
- **A session's first output no longer goes missing until "Reload chat".** When a session bound, its first sealed messages could arrive a beat before the key that opens them; the app stepped past them and never came back. It now waits for the key and retries.
- Machine and relay fixes shipped alongside (need the updated daemon/relay): a malformed request can no longer crash the relay or a machine's daemon; a failed `/steer` or login-code entry no longer takes the daemon down; a pi process dying mid-write no longer does either; a message to a session with no running agent no longer makes the daemon spin against the relay; a pairing approval can be collected exactly once.

# Sep 4 (5) — Download any file

- **Binary files can be downloaded.** A file that isn't text or an image (PDF, spreadsheet, archive, …) showed only a "binary file" notice with no way to save it, and the toolbar's download would have written an empty file. Both the file screen and the desktop file panel now have a Download button that fetches the file's bytes and saves it.

# Sep 4 (4) — Second bug-review pass

- **Restart keeps your permission mode.** A Claude session started in plan or default mode came back from Restart with every permission granted (bypass) — the mode was never carried over. It is now read off the session (or its record) and passed through; Codex keeps its mode, model and effort too. *Needs the updated daemon.*
- **Restart keeps queued messages.** Messages waiting behind a long turn were cancelled and dropped by Restart; they now move to the replacement and run in order. The turn that was interrupted ends as *cancelled* rather than *completed*, immediately.
- **Hand back survives a restart.** The peer link a handoff creates was only on the card; a restart (session or machine) rebuilt the card blank and "Hand back" refused with "not picked up". It's persisted now. A handoff resumed after a daemon restart never launches a second target, and a handback never delivers its note into a session that was restarted while it was being written.
- **Daemon-created sessions bind before they speak.** A handoff target is announced to the relay before its pickup prompt goes in, so its first answer is never dropped. A lost announce reply no longer strands a session forever.
- **Fork uses the model you switched to**, not the one the session launched with. **Teleporting the same conversation twice works.** pi and Codex forks are valid files again (the first append after a fork landed on the wrong line). A failed Restart archives the old card instead of leaving a live-looking ghost.
- **New session waits for the machine's model list** after you switch machines, so it can't send another machine's model id.
- Slash commands that generate (`/compact`, custom commands) get a short busy hold instead of none; the lease renewal runs on its own timer so a slow relay can't expire the daemon's lease.

# Sep 4 (3) — Bug-review fixes

- **Sessions the machine starts itself now show up.** A session created by `joy new`, by Fork, by Teleport, or as a Handoff target never got a card — the daemon had no way to announce a session it started on its own, so the app waited a minute and gave up while the agent ran unseen. They're announced within seconds now, sealed like any other. *Needs the updated daemon.*
- **Restarting an Antigravity or pi session keeps it that agent.** Both used to come back as a fresh Claude session.
- **Fork, Teleport and Handoff never revive a stale session in the same folder.** Creating a new session in a folder that held a detached one used to restart the old conversation instead — a handoff could hand its note to the wrong session.
- **Antigravity: forks copy a consistent snapshot; output after a daemon restart is no longer dropped.** Copies go through SQLite (the conversation store is write-ahead-logged), and every turn's records carry a per-boot id so the relay can't mistake them for replays.
- **Restart no longer archives the card it's keeping** (Codex, OpenCode, pi, Antigravity). **A failed teleport import can be retried.** **Exports and forks never cut a record in half** while the agent is still writing. **Steering an edited queue row sends the edited text.** **Peer links light up when the other session's card arrives.** New-session page sends the agent and model you actually picked. Antigravity and pi sessions no longer offer a Claude model picker. CPU/memory uses the machine's real page size and clock rate.

# Sep 4 (2) — Peer messages say who sent them

- **"from Claude Code · Greet CLI (774a97e6)" instead of "from 774a97e6".** A message another session sends into this one now names the sender — its agent, its title, its id — and tapping the line opens that session. The daemon stamps the label too, so it holds even for sessions this device never had a card for.
- **Antigravity and pi sessions are no longer anonymous.** A message they sent read "from cli" because their processes were never told which session they were; they are now, so their sends carry their identity like Claude's. *Needs the updated daemon.*

# Sep 4 — Hand off to another model, and back

- **Hand off.** From the session page, hand a session's work to a different agent or model — Claude to Antigravity, Opus to something cheaper, any harness to any other. The session writes a handoff note (goal, state, files touched, decisions, open questions, next steps, how to verify), and a new session in the same folder picks it up from the note. Nothing is copied but the note; files stay where they are.
- **Hand back.** The picked-up session shows a bar with a Hand back button: it writes its own note and the original session — which was only paused — receives it as a message and carries on with what changed.
- **The note says where the full story lives.** Every note ends with a reference block joy adds itself: which session and model wrote it, the working directory, the full transcript's path, the session's assets folder, and any earlier notes — so the next model can go read the real thing when the note isn't enough, and the file explains itself months later. *Needs the updated daemon.*

# Sep 3 (18) — Fork, Teleport, and a Restart that works

- **Restart keeps your session.** It used to archive the card you were on and spawn a new one elsewhere in the list. The session now comes back under the same identity — same card, same history.
- **Fork, one tap, from the session page — every agent.** A new session that continues from the last message, and you're taken straight to it. Claude forks natively; Antigravity, pi and Codex fork by copying their conversation under a new id. OpenCode can't be forked (its sessions live inside its server) and says so.
- **Teleport a session to another machine.** From the session page, pick a machine and a folder; the conversation continues there. Only the conversation travels — files are not copied, the folder is assumed to be in sync. Claude sessions for now. *Both need the updated daemon.*

# Sep 3 (17) — Antigravity sessions

- **New agent: Antigravity.** Google's `agy` CLI joins Claude Code, Codex, OpenCode and pi. Pick "antigravity" on the new-session page, choose from the models `agy models` offers, and chat as with any other session — tool calls show as cards with their output. It runs headless: one `agy` process per turn against a persistent conversation, so a session survives daemon restarts and the queue (edit, reorder, cancel, steer) is the daemon's own. Permissions are skipped, as with the daemon's default mode; there is no terminal pane. *Needs the updated daemon, and `agy` installed and signed in on the machine.*

# Sep 3 (16) — One "Queue" list

- **"Queued" and "Waiting to send" are gone; there is one list, Queue.** Everything you've sent that hasn't reached the agent yet — held in the app because a turn was running, or lined up on your machine — is one stack above the composer — the very same component as Drafts, no icons, always collapsible from its header however long the entries get: edit in place, × to remove, ⇡ to steer into the running turn, ↻ when a send keeps failing. A paused queue shows as a banner at the top of the same list.

# Sep 3 (15) — Fable in Limits, CPU and memory per session

- **Limits shows the Fable weekly window.** Claude's usage API reports model-scoped weekly limits in a separate list the app never read; Fable's was sitting at 68% while Limits showed only the two unscoped bars. Any model-scoped window now appears as "Weekly · ‹model›". A few codenamed experiment buckets that used to show up as bare ids at 0% no longer do. *Needs the updated daemon.*
- **CPU · Memory on the session info page.** Under Live: the agent's CPU (percent of one core, summed over its process tree — tool shells, dev servers, subagents) and resident memory, with the process count. Sampled when you open the page. *Needs the updated daemon.*

# Sep 3 (14) — Tool output in the cards

- **Claude's tool cards show what the tool printed.** A Bash call, a file read, a grep — the card now carries the output, and a call that failed is marked as failed. Until now a Claude card showed the command and that it had finished, and a command that exited with an error looked identical to one that succeeded. Very long output is trimmed to its beginning and end. *Needs the updated daemon.*

# Sep 3 (13) — Right-click a message on desktop

- **Right-click any message on desktop to open it in the text view** — the same one long-press opens on the phone — with Copy (the original markdown) and Reuse in its header. Right-clicking text you've already selected still gives you the browser's own menu.

# Sep 3 (12) — Copy and Reuse move to the text view

- **Copy and Reuse live in the text view now, not under every message.** Long-press a message (with the long-press copy mode on in Settings → Features) to open it in full; the header has Copy — the original markdown — and Reuse, which puts the text into the composer and takes you back to the chat. The per-message row is gone.

# Sep 3 (11) — Sends show up instantly

- **Your message appears the moment you send it.** It used to show only once the relay had accepted it and the app had polled it back — a visible lag on every send, and the reason tap-to-answer felt broken. Now it's in the chat immediately.
- **And it brightens as it travels.** 70% while it's only in your chat, 80% once the relay has accepted it, 90% once your machine has picked it up, 100% once the agent has it. A send that fails disappears and its text returns to the composer, as before.

# Sep 3 (10) — Waiting and Drafts are the same stack

- **Messages waiting to send look and behave exactly like drafts.** The two strips above the composer were separate things — different rows, different controls, one clipping at a fixed height and the other growing without limit. They're now one component: the same header with a count and collapse, the same inline-editable rows, the same × to remove. A draft keeps its ↑ to send now; a waiting message shows ↻ instead when its send keeps failing (it sends itself otherwise).
- **Long queues stop taking over the screen.** Either stack shows three rows and scrolls past that, with "+N more" in the header.

# Sep 3 (9) — Copy and Reuse on every message

- **Copy gives you the original markdown.** Selecting text in a message only ever copied what was rendered — bullets, headers and code fences were lost. Each message now has a Copy action that copies the message exactly as it was written. On desktop it appears when you hover the message; on the phone it sits quietly under it.
- **Reuse puts a message back in the composer.** Next to Copy. Tap it on anything you sent — or anything the agent said — and its text lands in the input, ready to edit and send. If you were already typing, it goes below your draft rather than replacing it.

# Sep 3 (8) — Attachments upload from the phone

- **Pictures and files send from iOS and Android again.** Hashing the sealed upload handed the native digest a raw buffer where it requires a typed array, so every attachment from a phone failed with "Upload Failed" before it ever reached the relay. Desktop and web were unaffected.

# Sep 3 (7) — Failed uploads say why

- **"Upload Failed" now names the reason.** An attachment that would not upload showed a generic message with the real error going only to the console — invisible on a phone. The alert now carries the failure itself (a status code, or the error), so a broken upload can be diagnosed from the device instead of guessed at.

# Sep 3 (6) — Scrolling, stuck states and the connection dot

- **Scrolling up no longer jumps.** The "loading older messages" spinner was mounted and unmounted at the very top of the list, growing and shrinking the header by its own height once per page fetched — so the chat lurched down and back up exactly where you were scrolling. The spinner's slot is now always there. Rows are also recycled by type, which removes the jitter underneath.
- **The connection dot tells the truth on phones.** It reported the state of a live stream that cannot open on iOS or Android at all, so it pulsed "connecting" forever while everything worked. It now reflects whether the app is actually reaching your machines.
- **`/effort` and `/model` no longer wedge a session.** Sending a CLI command that opens a picker left the session marked busy for up to three minutes, with anything you sent after it queued behind. *Needs the updated daemon.*
- **Background task counters unstick themselves.** A background agent whose completion was never recorded pinned the counter at "0/1" indefinitely — which also silently suppressed every turn-done notification for that session. Launches with no completion now age out. *Needs the updated daemon.*
- **One notification per turn.** A single turn end could buzz your phone two or three times. *Needs the updated daemon.*

# Sep 3 (5) — Notifications open the right session

- **Tapping a notification opens the session again.** Every session push carried the daemon's own internal id instead of the relay id the app addresses sessions by, so every tap landed on "Session has been deleted". Pushes now deep-link correctly; a session the daemon has not finished binding sends no link at all rather than one that breaks. *Needs the updated daemon.*
- **Reload Chat.** Session info has a new action that refetches one chat from scratch — for history that loads as empty. It only drops local state; nothing on the machine or the relay is touched. Previously the only way out was restarting the app.

# Sep 3 (4) — Compaction reads like a boundary, not a wall of text

- **The post-compaction summary is a card, not a giant message.** When a Claude session runs out of context it writes a long continuation summary; the chat had been showing that whole thing as if you had typed it. It now collapses into a "Compaction summary" row you can open when you want it.
- **The chat marks where compaction happened.** A quiet divider shows what triggered it, how long it took, and how much context came back — "Context compacted · 3m 3s · 385k → 17k" — so the gap in the conversation is explained instead of unexplained. *Needs the updated daemon.*

# Sep 3 (3) — Tap-to-answer options work again

- **Option chips render again.** A question with `<joy-options>` had been showing its raw tags as text since Jul 1 — a later change that hides joy control tags swallowed the opening tag, so the block was never recognised. Options are tappable chips again.
- **A held message now tells you why it is stuck.** Messages composed while the agent is working wait in the strip above the composer. If one fails to send, the row now shows the reason, and after the app stops retrying it says so and offers ↻ to try again — before, a failed send looked exactly like a message politely waiting its turn, forever.

# Sep 3 (2) — Voice is back, bring your own agent

- **Talk to your sessions.** The mic in the composer opens a voice conversation with your own ElevenLabs Conversational AI agent. It hears what the focused session is doing, can send a message into any session, answer a held tool approval, and read out a `<joy-options>` question so you can pick by voice. Works on phone, desktop and web.
- **Standing by costs nothing.** After a stretch of silence (45 seconds by default, Settings → Voice) the conversation hangs up but stays *armed*: when a turn ends, an approval is held or a question is asked, it reconnects and speaks. The spoken transcript carries over, so it picks up where you left off. The × on the voice bar ends it for good.
- **Wake by talking.** While idle and the app is open, the phone or browser listens locally (sound level only, nothing sent anywhere) and reconnects the moment you start talking; the bar reads "Joy idle · Listening". Off switch in Settings → Voice.
- **Limits page works again.** It read the pre-tunnel reply shape, so every machine showed blank bars; it now renders the daemon's normalized quota windows (Claude 5-hour and weekly, Codex weekly) and shows the daemon's reason when a provider can't be read.
- **`/joy-prompt` in the command picker.** Typing `/joy-` now offers it; it re-sends the current joy instructions to a running session (how sessions started before a daemon update pick up new instructions).
- **Bring your own agent.** Settings → Voice: add an agent by name and agent id (public agent), or with an API key (private agent with authentication on). The key lives in your encrypted settings and is only used to mint conversation tokens on your device; no server is involved.

# Sep 3 — Sessions can talk to each other

- **Messages from another session are marked.** When a joy session (or a script at a shell) sends a message into one of your sessions through the daemon, the chat shows a "from ‹session›" line above it and a quieter bubble, so you can tell a peer's message from your own. The agent sees the same provenance and knows where to reply.
- **Machine page: Environment.** Provider keys every new session on a machine should inherit (a Fireworks key for pi, for example) can now be added and removed from the machine page; they travel down the sealed tunnel once and are stored encrypted on the machine. Existing `~/.joy/env` files are sealed into the store automatically.
- **Pickers use `<joy-options>`.** The agent tag for tap-to-answer questions was renamed to match the rest of the joy tags; sessions pick it up on their next start or `/joy-prompt`.
- *Needs the updated daemon.* The `joy` CLI grew a matching set of verbs (`ls`, `check`, `about`, `ask`, `send`, `wait`, `events`, `abort`, `approvals`, `queue`, `mode`, `pane`, `env`).

# Sep 2 (5) — Sending from the phone works again

- **Messages send from iOS and Android.** Sealing a message used a text helper the native crypto module does not provide, so every send from a phone failed with "undefined is not a function" while reading worked. Desktop and web were unaffected.
- **Terminal, usage, files and git work from the phone.** The sealed tunnel to your machine used a cipher the native crypto module does not ship, so those screens failed the same way on iOS and Android. The tunnel now seals frames with libsodium's secretbox, which is native on the phone. *Needs the updated daemon: old and new tunnels cannot talk to each other.*

# Sep 2 (4) — Tool cards are back

- **The chat shows the whole turn again.** Since the move to the relay, sessions showed only your prompts and the agent's replies. Tool-call cards, thinking, turn lifecycle and per-turn token usage now flow from the daemon as sealed records for every agent (Claude, Codex, OpenCode, pi), rendered exactly as before. Prompts typed directly into the terminal pane appear as user bubbles as well. *Needs the updated daemon and relay.*

# Sep 2 (3) — Sends that fail come back

- **A message the relay did not accept is no longer lost.** Offline, a session still binding, a refused upload: the text and the pictures go back into the composer and you are told, instead of disappearing with nothing but a console line.
- **A retried message can no longer arrive twice.** The queued-draft release reuses the message's own id when it retries, and the relay treats that id as the identity of the message — a lost acknowledgement now replays the first delivery rather than queueing a second turn for the agent.
- **Long sessions no longer stall behind quiet pages.** Catching up after a reconnect could stop on a page of lifecycle-only events and never fetch what came after; the cursor now advances over them.
- **Attachment limits hold everywhere.** The 10MB per-file cap is checked on the bytes actually read, so pasted or dropped files on web can no longer slip past it; empty files are refused up front. Only PNG, JPEG, GIF and WebP render inline — other files show as a name and size row. Web previews release their memory once sent.
- **Removed from the app**: the never-shown "Sending… / Not delivered" line under messages and the long-press-to-fork gesture (neither could fire on the relay path), the subscription/RevenueCat code, the Claude.ai OAuth helper, the plaintext "Relay v2 Mode" developer screen, and a set of unused screens, hooks and native modules. Pairing a terminal now sends only the sealed data-key answer. *Needs the updated relay and daemon: `/joy/v1` is gone from the relay, the daemon refuses legacy (secret-based) pairings.*

# Sep 2 (2) — Attachments on the relay

- **Images and files send again.** Attaching a photo, file, paste or drawing to a message uploads it sealed with the session's own key — the relay stores bytes it cannot read — and the daemon drops the file into the session's folder and points the agent at it, so "look at this screenshot" works on every agent. If an upload fails the message is held back and you are told, instead of the text going out without its picture.
- **Attachments show in the chat.** Your sent images appear inline above the bubble (a blurred placeholder until the bytes load), other files as a name and size row, on every device signed in to the account.
- **Re-pair after updating.** The keys that seal session content are now derived under Joy's own name rather than the old Happy labels. Sealed history written before this update cannot be opened by the new app, and terminals paired before it must be paired again. *Needs the updated daemon on the machine.*

# Sep 2 — Joy only

- **The Happy Cloud relay is gone.** Server Configuration lists Joy Relay only, it is the default for new installs, and the server check now confirms it is talking to a joy-relay rather than looking for the old server's welcome banner. Custom relay URLs still work. Existing logins and caches on Joy Relay carry over unchanged.
- **Links are `joy://`.** The terminal-pairing and account-restore QR codes and the "paste URL" flows now use `joy://…` instead of `happy://…`; the app registers the `joy` scheme on iOS and Android. Old `happy://` links no longer open.
- **Voice, GitHub connect, artifacts, usage dashboards and connected services are removed.** None of them had a backend on the joy relay, so they could only fail; their settings pages, the microphone permission and the audio/voice libraries are gone with them.
- **Settings are per device.** Preferences no longer try to sync to an account-settings store the relay never had.
- **Machine page shows the daemon.** Version and Joy home directory appear alongside host and home; machines registered by an older daemon still list fine.
- **Renamed under the hood** — nothing to do: the resume snippet is now `joy new . --resume <id>`, the offline hint says `joy status`, the CLI install hint points at `@fny/joy-daemon`, and the desktop app calls itself Joy in its menu and window titles.

# Sep 1 (2) — Idle sessions stay in the sidebar

- **A live session no longer vanishes 90 seconds after its last reply.** The app judged "still alive" by the time of the last turn, which under v2 nothing refreshed while you weren't talking — so a freshly created session dropped out of the active list (or off the sidebar entirely) as soon as it sat idle. Liveness now follows the daemon's relay lease, the same signal that decides whether a message would be delivered: online means active, however long it's been quiet, and a daemon that dies shows offline within about 20 seconds.
- **Sessions that died while their daemon was down are archived, not haunted.** A session the relay still believed was running — but that no machine actually had anymore — grouped itself under "Yesterday" / "2 days ago" and then hid, leaving a date header with nothing under it. Two fixes: the daemon now archives any session it's supposed to own but has no runtime for the moment it reconnects, and the sidebar decides "active" once, the same way for grouping and for showing, so a row can never be filed as history and then dropped as active.
- **Desktop shows its release.** The JS-update row on web/desktop now always shows the commit and release time instead of "web bundle (unstamped build)".

# Sep 1 — Everything speaks v2

- **The entire app now runs on the joy relay's v2 surface.** Login, the session and machine lists, chat, push registration, the message queue, codex approvals, files, git, terminal, usage, limits, agent config, history — every call the app makes goes to `/joy/v2` or through the end-to-end-encrypted machine tunnel. The happy socket is gone from the app entirely; live updates arrive over the relay's event stream with a polling fallback.
- **Session cards are sealed.** The daemon publishes each session's name, path, state and queue as an encrypted card only your devices can open — the relay stores ciphertext. Presence now comes from the same lease signal the work queue dispatches on, so "online" can never disagree with "a message would actually be delivered".
- **First message can't vanish.** Creating a session with an initial prompt used to race the daemon's bind and silently lose the message; the app now waits for the bind (and refuses to ever send unencrypted while waiting). If an initial send fails you see the error.
- *Needs the updated relay and an updated daemon on the machine.*

# Aug 31 (3) — The terminal says why it is empty

- **A session the machine no longer has now says so.** Opening the terminal for a session the daemon doesn't know showed an empty black terminal with a small "session_not_found — retrying…" note, as though it were still loading — it never would. It now states plainly that the session ended or the daemon restarted without reattaching it. Same for a machine your account can't reach.
- Genuine blips (a timeout, a daemon restarting mid-poll) still show the retry banner and still recover on their own.

# Aug 31 (2) — Terminal view fixes

- **The terminal opens on your session, not on a blank.** The view sized the tmux window to twice the height it renders, so Claude — which pins its input box to the bottom — put the box at the fold with a screenful of empty space above it, and the conversation a full screen higher. The window now matches what you actually see. (Scrolling back further is gone with it; Claude keeps no terminal scrollback, and the taller window was the only way to fake it.)
- **Rotating no longer leaves the pane the wrong height.** A resize was only sent when the column count changed, so a height-only change kept a stale row count.
- **The terminal can no longer shrink your session to 20×10.** Opening it before the layout had measured sent a real 20×10 resize, which stuck after you left the screen — leaving a session whose terminal shows nothing useful and whose typed messages can stop landing.

# Aug 31 — Every joy session runs on v2

- **v2 is the only path now.** New joy-tmux sessions always run on the v2 relay pipeline — the "via v2 relay" tick is gone because it is no longer a choice. Sends, cancels, files, git, terminal, usage and history all travel the sealed v2 path, and every option the old screen offered (model, effort, permission mode, fallback model, continue/resume, fork, extra arguments) rides along with the spawn. *Needs an updated daemon on the machine.*
- **Sessions in a brand-new folder start properly.** Claude asks whether you trust a folder it has not seen before. Joy was answering that prompt with the wrong option and quietly shutting the session down, so anything you typed sat unsent forever. It now answers correctly no matter how the prompt is laid out.
- **Changes tab works on a cold open.** Opening a session's Changes straight from a link used to say "not a git repository" until you navigated away and back. It now waits for the session to load instead of giving up.
- **Per-session usage over v2.** The session usage screen reads its cost row through the new path in one call, and no longer fails with an encryption error on v2 sessions.

# Aug 30 (2) — v2 on the main relay, create-directory prompt

- **v2 works on the Joy Relay.** The main relay now serves the v2 pipeline, so v2 sessions work without switching relays — no more errors when a session tries the new path.
- **"Create directory?" on v2.** Starting a v2 session in a folder that does not exist now asks whether to create it, the same as a normal session, instead of spinning forever.

# Aug 30 — v2 sessions, end to end (developer)

- **v2 as a real transport (opt-in per session).** New joy-tmux session → tick **via v2 relay** and the session runs over the new relay pipeline: sends and cancels travel the durable, end-to-end-encrypted v2 path, while the conversation still shows the same way. Everything is sealed — the relay stores ciphertext it cannot read. *Needs a relay serving `/joy/v2` and an updated daemon on the machine.*
- **V2 badge.** Sessions running on the v2 path show a small **V2** tag in the session list, so it is clear at a glance which are the new-pipeline sessions.
- **Safer by construction.** A v2 session refuses to send if it cannot encrypt (never falls back to plaintext), image attachments are blocked with a clear message on the v2 path for now, and cancelling a v2 turn goes through the one clean path.

# Aug 26 — Relay v2 Mode (developer), header search

- **Relay v2 Mode (Developer).** Settings → Developer → Relay v2 Mode drives sessions over the new native `/joy/v2` relay surface end to end: create a session on a machine (pick the folder and agent), watch the reply stream in live, edit/reorder/delete queued messages, retry a failed delivery, cancel a running turn, send attachments. It's the testing surface for the next-generation sync — *needs a relay serving `/joy/v2` and an updated daemon on the machine.*
- **Search from the header.** The session header gains a search button that opens the find bar — same as pressing Cmd+F on desktop.
- **Relay password stays home.** The per-relay password now only ever accompanies requests to exactly the configured relay origin — a look-alike domain can no longer receive it.

# Aug 19 — Lighter app, file delete, relay passwords

- **~3.5 MB smaller.** The app was shipping all 19 icon fonts — including families it has never drawn a single glyph from. It now bundles only the two it actually uses (Ionicons and Octicons); everything that referenced the others was moved onto equivalents.
- **Delete a file from the file viewer.** A trash button sits next to Download. It confirms first, naming the file, and there is no undo — the daemon unlinks it. Directories are refused, and it only reaches inside the session's own folder. *Needs the machine's daemon updated to work.*
- **Relay passwords, per relay.** Settings → Account: each relay row has a lock you can tap to set that relay's password. This matters before switching to a gated relay — it refuses the connection without the key, so it has to be set in advance.
- **Composer tidy-up.** The draft button is now a save icon (it saves a draft), settings sits before the paperclip, and the icon row's spacing is halved without shrinking the tap targets.

# Aug 18 — Identicons, tidied

- **Identicons: circles and squares.** The hashicon style is retired; identicons are now the joy-palette confetti grid clipped two ways — Circles (the new default) or Squares. Pick in Appearance → Identicons.
- **Smaller by default, finer control.** Identicon size now defaults to 16px and ranges 8–24 in 2px steps (it was 24px, 16–48 in 4s). If you had it set larger, it pins to the new maximum.
- **Session list lines up.** The project identicon now sits on the same column as the status dots in the rows below it, and the folder name starts exactly where the session titles do.
- **Icon browser (Developer).** Settings → Developer → Icons lists every icon in every family the app ships — search by name, tap one to copy its name.

# Aug 17 — Queue crash fixed, ordering, desktop drawing

Fixes for yesterday's batch: the big one is a crash that could take down the whole session screen the moment a message actually queued.

- **Session screen no longer crashes on queueing.** When a message entered the daemon queue (the QUEUED strip appearing), a React hooks bug could crash the entire conversation view to the error screen. Fixed.
- **Queued messages land in order.** A message released after a turn now waits for the turn's final answer to arrive before sending, so it appears *after* the response it queued behind — not spliced into the middle of it.
- **Drawing works on desktop.** The sketch pad now uses a real canvas on web/desktop — mouse strokes draw properly and save reliably. (It was effectively dead there before.)
- **Identicon alignment, actually fixed.** Session-list identicons now line up exactly with the session title edge.
- **Quieter paperclip.** The attach button no longer lights up when attachments are present — the thumbnails already tell you.
- **Draft pencils.** Sessions with saved drafts show the same plain pencil in the session list as the composer's draft button.

# Aug 16 (2) — Less noise, real limits, a sketch pad

A quality-of-life sweep: collapse the chat clutter, see your actual Anthropic/OpenAI quota, draw on your screen, and edit any agent's config from your phone.

- **Collapse everything.** A new top-left button in each session collapses/expands every tool call at once; each tool card and each code diff also gets its own chevron. Compaction summaries now appear as a collapsed card instead of vanishing (or walling the chat).
- **Live account limits.** Settings → Limits shows your real Claude 5-hour/weekly utilization and reset times (read via each machine's own Claude Code login — no credentials to enter) plus Codex's rate windows. The daemon also pushes an alert when any quota, RAM, or disk crosses 90%.
- **Drawing attachments.** The attach menu gains Draw: a full-screen sketch pad — five pens, white/black paper, adjustable thickness, smooth finger strokes — and you can paste or pick an image to annotate on top of. The PNG drops straight into the composer.
- **Agent config editor.** Settings → Agent Config edits each agent's real config file (claude settings.json, codex config.toml, opencode, pi) on any machine: walk the published schema or use raw mode with JSON-path lines like `examples[0].title = "hi"`. Every write keeps a backup.
- **/joy-prompt.** Re-injects the latest joy instructions into a long-lived session (any agent) — the fix for stale titles and forgotten option pickers; it's also how pi learns the vocabulary.
- **Resource pressure, visible.** Machine view shows Memory and Disk as used-% (red at 90%+), and a red banner appears under a session's header when its machine runs hot.
- **Usage, faster + honest pills.** Usage reports answer instantly after daemon restarts (persistent cache, background-refreshed every 2h) and the period pills finally show which one is active in dark mode.
- **Queue steer arrow.** Each queued message has an arrow that sends it immediately (mid-turn) instead of waiting its turn.
- **Simpler terminal view.** The claude status chrome (permission hints, widgets) is filtered out by default — tap Full to see everything.
- **Session list by agent.** Settings → Sessions labels and sorts sessions by agent flavor, with a better icon.
- **Leaner relay picker.** The dev and direct doors are gone — Happy Cloud and Joy Relay only.
- **Esc stays in the chat.** Pressing Escape in a session aborts the running turn (or does nothing) instead of navigating you out mid-conversation. Subpages and the mouse back-button still go back.
- **Identicon styles.** Appearance → Identicons: pick between the hashicon mark, a square confetti grid, or a circular one — all drawn strictly from the joy logo palette, with live previews. Folder names in the session list are now bold in the standard text color. Identicons now align with session titles, and their size is adjustable (16–48px). The draft button is a plain pencil.
- **Relay access key.** Your relay can now require a perimeter key on every connection — strangers can't even create accounts on it. Set the key in Server Configuration; Happy Cloud and open relays need nothing.
- **Notification taps open the session.** Tapping a notification now lands you in the right conversation — on mobile (including cold start, which used to drop the tap) and on desktop (web notifications navigate on click; the Mac app jumps to the session when you activate it from a banner).
- **Desktop links fixed.** Links in chat are real links again — click to open in your browser; right-click/copy/cmd-click behave like a browser.
- **App Lock.** Optional Face ID / device-PIN lock (Settings): the app locks on launch and whenever it returns from the background. Turning it off requires authenticating too.

# Aug 16 — Your own relays, new agents, big files

Joy now runs on its own infrastructure, speaks four agent flavors, and the file viewer handles real files.

- **Self-hosted relays.** Switch between Happy Cloud and the new joy relays right from Server Configuration — with three doors into the joy universe (stable, dev, and direct) for testing relay changes against live data.
- **One key everywhere.** Your original secret key now works on every relay: "Use this key on all relays" sets up each one in a tap, and `joy auth <relay>` pairs any machine from the same backup code — no more per-relay accounts.
- **New agent: opencode.** Full-featured sessions on open models (Kimi K3 on Fireworks by default) — steering, queueing, model switching, past-session resume, auto-titles.
- **New agent: pi.** A fourth flavor with native mid-turn steering and harness-owned queueing, also running Kimi K3.
- **Big files in the file viewer.** Files up to 10MB now load (was ~700KB) — bytes ship as encrypted blobs instead of squeezing through the realtime channel.
- **File viewer overhaul.** One file at a time, downloads, image rendering, and source/rendered modes for CSV, TSV, Markdown, and fully-working self-contained HTML.
- **Queued messages actually send.** Messages queued while the agent was busy could sit forever after an app reload — the release valve now arms on every boot.
- **File browser + attachments always on.** No more experiment toggles — the full UI is there on every account and relay.
- **Fewer duplicate machines.** Each computer registers once per universe, not once per relay door.
- Renamed the machine-side daemon to joy-daemon, with clean automatic service migration on update.
- **Search a conversation (⌘F).** Press ⌘F (Ctrl+F) in a session to search its messages — Enter/↑↓ jump between matches and scroll the chat to each one. Searches the loaded conversation; scroll up first to include older history.
- **Stop button in the composer.** While the agent is working, the send button becomes a square stop button — tap to interrupt; start typing to queue a follow-up instead. The save-draft button moves to where stop used to be.
- **New avatars.** Sessions and machines now use hashicon identicons — distinctive geometric marks derived from each id.
- **Desktop: text selection works again.** Code blocks and chat text can be selected and copied in the desktop app (the native-feel styling was suppressing it).

# Jul 3 — Consistent status, working scrubber, /title

Small polish across the chat and machine views, plus fewer false "failed to send" alarms.

- Session status color is now consistent everywhere — the sidebar dot and the chat header no longer disagree (teal while finishing background tasks, yellow for permission prompts).
- The "jump to previous prompt" arrow works when you're scrolled to the very bottom of a chat, instead of doing nothing.
- `/title` shows up in the slash-command menu, so you can rename a conversation without remembering the command.
- Tap a machine's command count to see the full list of slash commands it found (plugins marked), so it's clear what's available.

# May 15 — Cleaner, steadier chat

Less clutter in the conversation, fewer stuck states, smoother scrolling.

- Slash commands render as a clean chip — no more raw command markup or duplicated text.
- Skill runs no longer dump a wall of raw instructions into the chat.
- Chats pick up their real title instead of staying stuck on "New chat".
- The view stays put while the agent streams — no more scroll jumps when you've scrolled up to read.
- "Permission required" prompts clear properly after a session is interrupted.
- Resumed sessions no longer replay your whole history as duplicate messages.
- Slash-command and file autocomplete shows more results and keeps the highlighted item in view.

# May 13 — Faster long chats

Long sessions open instantly. Messages load latest-first with older history streaming in on scroll.

- Parallel decryption — no more freezing on sessions with thousands of messages.
- Backward pagination — scroll up to load history on demand.

# May 7 — Session retention, new sidebar, code editor, session branching

Desktop got a full refresh with a file browser, built-in editor, and zen mode. Sessions can now be branched or rewound.

**Session retention: 2 months.** Older sessions are cleaned up automatically to keep storage costs manageable.

## Features and fixes

- Thinking effort selection bug fixed.
- Smarter push notifications — suppressed when you're already in the app.
- Unread dots persist on sessions until you open them.
- Redesigned sidebar with file browser, code editor, and zen mode.
- Fixed stale sessions refusing to load, blank screen on launch, dual cursors in remote mode, `claude --resume` not finding Happy sessions.

## Experimental

Enable in Settings → Features:

- File diffs sidebar — see git changes next to chat on desktop.
- Session fork & rewind — branch off any session or roll back to any message.

# April 26 — Voice fixes, diffs, scroll

Voice actually works reliably now, plus better content rendering.

- Voice calls no longer break on second session.
- Tables and code blocks scroll horizontally.
- New diff viewer with syntax highlighting and unified/split toggle.
- Model and effort choices persist on mobile.
- Permission prompts no longer get lost.
- Settings stop randomly resetting during sync.
- Scroll-to-bottom button in chat.
- Delete machines from settings.

# April 8 — Gemini models, voice onboarding, CLI fixes

New models, smoother onboarding, fewer CLI hangs.

- Latest Gemini models in the picker.
- Better voice onboarding — clearer first-run prompts.
- CLI plan approval buttons actually show up now.
- CLI background tasks and Codex turns no longer hang.

# March 19 — New session screen, git worktrees, more agents

Completely new way to start sessions, plus worktree support and more agents.

- New session composer — pick machine, worktree, draft persists.
- Git worktree management from the app. Auto-cleanup on delete.
- Auto plan mode when your agent enters planning.
- OpenClaw as a selectable agent.
- Session quick actions, resume, delete from info screen.
- "Bypass" renamed to "yolo".

# December 22 — Agent updates, voice changes, tables

Agent config changes and voice pricing heads-up.

- Gemini support coming via ACP.
- Model config removed from app — use CLI defaults.
- Voice going subscription after 3 free trials.
- Markdown tables render properly now.

# September 12 — Codex, daemon mode, one-tap launch

Sessions start instantly now. No more manual CLI startup.

- Codex support for code completion and generation.
- Daemon mode — sessions start instantly without manual CLI startup.
- One-tap launch from mobile.
- Connect Anthropic and GPT accounts.

# August 29 — GitHub integration

Your GitHub identity in Happy.

- Connect your GitHub account via OAuth.
- Avatar, name, and bio sync to the app.
- Encrypted token storage.

# June 26 — QR login, dark mode, voice

Link devices instantly, look good doing it.

- QR code auth for instant device linking.
- Dark theme with system preference detection.
- Faster voice responses.
- Modified file indicators in session list.
- 15+ languages for voice.

# May 12 — Hello world

First release. Everything is new.

- E2E encrypted sessions.
- Voice assistant.
- File manager with syntax highlighting.
- Real-time sync across devices.
