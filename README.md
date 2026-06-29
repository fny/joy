<div align="center">
  <img src="/.github/joy-logo.png" width="260" alt="joy" />
</div>

<h1 align="center">joy</h1>

<h4 align="center">
Control your Claude Code sessions from your phone, web, or desktop — end-to-end encrypted.
</h4>

---

`joy` is a personal fork of [Happy Coder](https://github.com/slopus/happy). It pairs a
client app with a tmux-based daemon so you can drive Claude Code from anywhere: the daemon
runs your sessions on your machine, the app mirrors them in real time over an end-to-end
encrypted relay, and you can take over from any device.

The two packages that make up joy are:

- **[joy-app](packages/joy-app)** - the client. Mobile (iOS/Android via Expo), web, and
  macOS desktop (Tauri). This is the real app you interact with.
- **[joy-tmux](packages/joy-tmux)** - the daemon + `joy` CLI. Runs Claude Code sessions
  inside tmux, drives them over tmux control mode, tails their transcripts, and bridges
  everything to the relay. This replaces the happy-cli wrapper.

The `happy-*` packages in this repo are a pristine mirror of upstream
[slopus/happy](https://github.com/slopus/happy), kept around for reference and for porting
upstream changes — joy's own code lives only in `joy-app` and `joy-tmux`.

## How does it work?

The `joy-tmux` daemon launches `claude` inside a tmux window and manages it for you —
scraping the pane, queuing input, and streaming the transcript to the relay. The app
connects to the same relay and shows your sessions live; anything you send from the app is
typed into the real Claude session, and anything you type directly is mirrored back to the
app. Because every session runs in tmux, the daemon can restart and re-adopt live sessions
without losing your work.

## Why Joy?

- **Mobile access to Claude Code** - check and steer what your agent is doing from anywhere
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

### Run the daemon (joy-tmux)

The daemon reads your Happy/joy account credential from `~/.happy/access.key`
(set `HAPPY_HOME_DIR` to point elsewhere). Provision it once with the upstream happy CLI
login flow if you don't have one yet.

```bash
cd packages/joy-tmux

pnpm typecheck && pnpm test   # verify the build
pnpm start                    # run the daemon (tsx src/server.ts)
```

Or install the published CLI globally and run `joy`:

```bash
pnpm install -g @fny/joy-tmux
joy
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

## License

MIT License — see [LICENSE](LICENSE) for details.
