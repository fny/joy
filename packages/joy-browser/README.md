# joy-browser

An extension for Chrome and Firefox that ties one joy session to your browser.
You pair it once, it starts a headless session on a machine you pick, and from
then on a draggable chat button on every page talks to that session. The
session's agent can run JavaScript in your tabs, and can ask to keep a script so
that it runs on every visit to a site.

It is a client of your account, like the app and the MCP server. It talks only
to your relay: nothing listens on your machine, no port is opened, and the agent
can be on a different machine from the browser.

In **Direct mode** the session is local-only on the machine (never announced to
the relay), and the extension reaches the daemon's own API over a WebRTC data
channel. The relay carries only the setup: the offer and the answer, sealed in
the tunnel under the machine's key, so it cannot read or swap them. The daemon
side is `joy-daemon/src/transports/rtc.ts` (`POST /v2/rtc/connect`).

```
 agent (any machine)             relay                     your browser
┌─────────────────────┐   ┌────────────────┐   ┌──────────────────────────────┐
│ emits a tag in its  │──►│ sealed output  │──►│ extension opens it, runs the │
│ reply, ends the     │   │                │   │ script in a tab              │
│ turn                │◄──│ durable queue  │◄──│ queues the sealed result     │
└─────────────────────┘   └────────────────┘   └──────────────────────────────┘
```

The user's guide is [docs/guides/browser.md](../../docs/guides/browser.md). This
file is for working on the extension.

## Install

The package has no dependencies, and Chrome needs no build step.

- **Chrome.** `chrome://extensions` → **Developer mode** → **Load unpacked** → this directory.
- **Firefox, for good.** `WEB_EXT_API_KEY=… WEB_EXT_API_SECRET=… pnpm sign:firefox`, then open the `.xpi` from `dist/signed/`. See [Signing](#signing-for-firefox).
- **Firefox, until it closes.** `pnpm build`, then `about:debugging` → **This Firefox** → **Load Temporary Add-on** → `dist/firefox/manifest.json`.

Sessions learn the tags from the daemon's system prompt (`BROWSER_SECTION` in
`joy-daemon/src/domain/agentTagsPrompt.ts`), so the daemon on the agent's machine
must be recent enough to carry them. A session that was already running when its
daemon updated learns them from `/joy-prompt`.

## What the agent writes

```
<joy-browser-execute>
return [...document.querySelectorAll("h2")].map((h) => h.textContent);
</joy-browser-execute>
```

The body is the inside of an async function running in the page: `await` works,
and `return` is the answer. Attributes on the opening tag choose where it runs:

| Opening tag | Runs in |
|---|---|
| `<joy-browser-execute>` | the active tab |
| `<joy-browser-execute tab="123">` | that tab |
| `<joy-browser-execute url="https://…">` | a new tab at that URL, once it has loaded; the body may be empty |
| `<joy-browser-execute tab="list">` | nowhere: reports the open tabs |

The result names the tab it ran in, `status: ok` or `status: error`, the returned
value as JSON, and anything the script logged. The round trip is a turn boundary,
not a tool call: the agent ends its turn after the tag, and the result is its next
message, wrapped as `<joy-message from="browser">`.

```
<joy-browser-remember name="Hide the sidebar" match="example.com, *.example.org/app/*">
document.querySelector("#sidebar")?.remove();
</joy-browser-remember>
```

This asks the extension to keep the script. It is stored **off and unapproved**;
only the user can approve it (chat panel, or Settings → Saved scripts), and a
changed script loses its approval. An approved script runs on every completed
load of a matching page. The same name replaces the earlier version.

## What runs, and what never does

- **Only the agent's own reply text.** A tag in a prompt, in a user's message, in the agent's thinking, or inside a fenced code block never runs. That includes the extension's own results: a page cannot print a tag into a result and have it executed.
- **Only from the moment of linking.** The watcher starts at the end of the conversation, so a tag from earlier does not fire because a browser appeared.
- **At most once.** The position in the conversation is saved before a script runs. If the browser dies mid-script the agent gets no answer and can ask again; a click or a form submit is never repeated on restart.
- **Never on an excluded site.** The check is made on the `url=` the agent gave and again on the tab's address after it loaded, so a redirect onto an excluded site is refused too. Excluded tabs are left out of `tab="list"`, saved scripts skip them, and the page button is not injected there.
- **Never while paused.** Pause refuses agent scripts and silences saved ones.

## How it is put together

| File | Part |
|---|---|
| `background.js` | Everything with state: setup, the linked session (spawn, relink, respawn when it ended), the watcher, the two brakes, saved scripts, and the chat feed the page button connects to. A service worker in Chrome, a background page in Firefox. |
| `content.js` | The page button and chat panel, in a closed shadow root. Self-contained: content scripts cannot import. |
| `popup.html`, `popup.js` | Setup, status, Pause, and the Settings pages. Stateless: every screen is drawn from the background's `status`. |
| `src/runner.js` | Runs a script in a tab. Chrome: `chrome.debugger` → `Runtime.evaluate`, because Manifest V3 will not evaluate a string. Firefox: `tabs.executeScript({ code })`, which is why the Firefox build is Manifest V2. |
| `src/watcher.js` | Reads the session's events, finds tags in agent text, runs each once, queues the answers. |
| `src/tags.js`, `src/patterns.js`, `src/conversation.js` | Pure: tag parsing and result formatting, site patterns, folding events into chat rows. |
| `src/crypto.js`, `src/relay.js` | The account client: tweetnacl and WebCrypto only. |
| `src/direct.js` | Direct mode: `DirectClient` has the relay client's methods, mapped onto the daemon API over the data channel (HTTP in JSON frames). Its events carry their payload open (`{ seq, payload }`). |
| `src/tunnel.js` | The sealed tunnel, for the one call that uses it: the WebRTC offer and answer. |
| `src/peer.js`, `offscreen.html`, `offscreen.js` | The peer connection. It needs a page: Firefox's background page holds it, and in Chrome the offscreen document does, driven over a port. |
| `manifest.json`, `manifest.firefox.json` | One per browser. `build.mjs` writes `dist/chrome` and `dist/firefox`; keep the two versions equal. |

Things that follow from the platform:

- **The debugging bar (Chrome).** Chrome shows "Joy Browser is debugging this browser" while a script runs. The debugger is attached per script and detached afterwards.
- **Latency (Chrome).** Chrome stops an idle service worker. An alarm wakes it every 30 seconds, so a script waits at most that long; an open chat panel holds a port and pings, which keeps it awake. Firefox's background page does not sleep.
- **Console capture (Firefox).** A content script sees only its own `console` calls, so a result carries what the script logged, not what the page logged. Chrome carries both.
- **Phones (Orion on iOS, for one).** `content.js` detects a phone by its physical screen and turns the panel into a full-width sheet above the keyboard (`visualViewport`), with 16px inputs so iOS does not zoom. A page with no viewport meta is laid out ~980px wide on a phone; the widget counter-zooms so it keeps its real size. The popup carries a viewport meta for the same reason. Only the Firefox build can work in a WebKit browser: there is no `debugger` API there.
- **The backup code is the whole account.** It is kept in the profile's extension storage so the extension can sign in again by itself. **Clear everything** removes it.

## Signing for Firefox

Release Firefox installs only extensions Mozilla signed. `pnpm sign:firefox`
builds `dist/firefox` and submits it with `web-ext sign --channel unlisted`:
signed, but never listed on addons.mozilla.org. It needs `WEB_EXT_API_KEY` (the
JWT issuer) and `WEB_EXT_API_SECRET` (the JWT secret) from
<https://addons.mozilla.org/developers/addon/api/key/>. The `.xpi` lands in
`dist/signed/`.

- The add-on id (`browser_specific_settings.gecko.id`) belongs to the first Mozilla account that signs it. Signing under another account needs another id.
- A version can be signed once. Bump `version` in both manifests to sign again.
- The manifest declares `data_collection_permissions` for website content and browsing activity: script results leave the browser for the relay, and Firefox shows that at install.

## Tests

```bash
pnpm test             # crypto, tags, patterns, conversation, watcher — plain node, no browser
pnpm lint:firefox     # web-ext lint on the Firefox build
pnpm smoke:chrome     # real relay + real Chromium: [path to chrome]
pnpm smoke:firefox    # real relay + real Firefox:  <path to firefox> <path to geckodriver>
pnpm smoke:direct:chrome    # Direct mode, same arguments as above
pnpm smoke:direct:firefox
```

The Direct smoke tests start `test/direct-daemon.ts` with the daemon's tsx: the
real tunnel executor and WebRTC transport, in front of the few daemon routes
Direct mode calls and an agent the test plays. They prove the relay never lists
a session for the account.

The two smoke tests run one scenario (`test/smoke-lib.mjs` holds the relay and a
hand-played daemon): pair in the popup, pick a machine, the extension spawns its
session, scripts run and fail properly, a message typed into the page panel
reaches the session, a remembered script stays off until approved and then runs
by itself, an excluded site refuses everything, and Pause refuses everything.
They are not part of `pnpm test` because they need browsers.

The crypto tests seal with this package and open with `joy-mcp`'s Node client,
and the reverse, so the two cannot drift apart. `packages/joy-relay/test/joy-browser.e2e.test.mjs`
runs the extension's relay client and watcher against a real relay.

`vendor/nacl-fast.min.js` is [tweetnacl](https://github.com/dchest/tweetnacl-js) 1.0.3,
unmodified and in the public domain (Unlicense). It is vendored so that loading
the directory unpacked works with no install.
