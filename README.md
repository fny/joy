<div align="center">
  <img src="/.github/joy-logo.png" width="260" alt="joy" />
</div>

<h4 align="center">
Control your coding agents — Claude Code, Codex, OpenCode, Pi — from your phone, web, or desktop. End-to-end encrypted.
</h4>

---

`joy` is a personal fork of [Happy Coder](https://github.com/slopus/happy). It pairs a
client app with a tmux-based daemon so you can drive coding agents from anywhere: the
daemon runs your sessions on your machine, the app mirrors them in real time over an
end-to-end encrypted relay, and you can take over from any device.

The packages that make up joy are:

- **[joy-app](packages/joy-app)** - the client. Mobile (iOS/Android via Expo), web, and
  macOS desktop (Tauri). This is the real app you interact with.
- **[joy-daemon](packages/joy-daemon)** - the daemon + `joy` CLI. Runs agent sessions
  (claude in tmux control mode; codex, opencode, and pi through their native protocols),
  tails their transcripts, and bridges everything to the relay. Also serves a local REST
  API (`/docs?token=…` on each machine) and a scripting CLI (`joy run/ask/send/wait`).
- **[joy-relay](packages/joy-relay)** - the self-hosted relay: a gated proxy in front of
  happy-server plus the native `/joy/v1` durable-session protocol (see
  `https://joy.voltai.party:4997/docs`).

The `happy-*` packages in this repo are a pristine mirror of upstream
[slopus/happy](https://github.com/slopus/happy), kept around for reference and for porting
upstream changes — joy's own code lives only in `joy-app` and `joy-daemon`.

## How does it work?

The `joy-daemon` daemon launches your agent (e.g. `claude`) inside a tmux window and
manages it for you — scraping the pane, queuing input, and streaming the transcript to
the relay. The app
connects to the same relay and shows your sessions live; anything you send from the app is
typed into the real Claude session, and anything you type directly is mirrored back to the
app. Because every session runs in tmux, the daemon can restart and re-adopt live sessions
without losing your work.

## Why Joy?

- **Mobile access to your agents** - check and steer what they're doing from anywhere
- **Switch devices instantly** - pick up from phone, web, or desktop; the tmux session keeps running
- **Everything mirrors** - app, web, and direct terminal input all propagate to every client
- **End-to-end encrypted** - your code never leaves your devices unencrypted
- **Yours to hack** - a small, readable daemon and a single app, no telemetry

## Quick build

Prerequisites: **Node 20+**, **[pnpm](https://pnpm.io) 10+**, and **tmux** (for the daemon).

```bash
# 1. Install all workspace dependencies
pnpm install
```

### Run the daemon (joy-daemon)

Pair a machine with your relays from your account backup code (one code works on every
relay): `joy auth <relay…>`. Credentials land under `~/.joy/relays/` (default-relay creds
in `~/.happy/access.key`; set `HAPPY_HOME_DIR` to point elsewhere).

```bash
cd packages/joy-daemon

pnpm typecheck && pnpm test   # verify the build
pnpm start                    # run the daemon (tsx src/server.ts)
```

Or install the CLI globally straight from the repo's release branch (npm publish is
retired) and run `joy`:

```bash
pnpm add -g "git+https://github.com/fny/joy.git#release&path:packages/joy-daemon"
joy install     # autostart service; `joy update` self-updates from the release branch
```

### Run the app (joy-app)

```bash
cd packages/joy-app

pnpm web            # web client at http://localhost:8081
pnpm ios            # iOS (Expo)
pnpm android        # Android (Expo)
pnpm tauri:dev      # macOS desktop (Tauri)
```

Log in with your account secret key, and your daemon's sessions will appear in the app.

## Docs

- [docs/FEATURES.md](docs/FEATURES.md) — the feature map and how the pieces connect.
- [docs/API.md](docs/API.md) — relay + daemon operation reference. Live, generated specs:
  `GET /openapi.json` (keyed) on each daemon, and `/docs` on the relay.
- [packages/joy-daemon/CLAUDE.md](packages/joy-daemon/CLAUDE.md) — daemon dev notes.

## License

MIT License — see [LICENSE](LICENSE) for details.
