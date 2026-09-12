<div align="center">
  <img src="/.github/joy-logo.png" width="260" alt="joy" />
</div>

<h4 align="center">
Run coding agents on your own machines. Drive them from your phone, the web, or your desktop. End-to-end encrypted.
</h4>

---

joy mirrors terminal coding agents — Claude Code, Codex, OpenCode, and Pi — to every device you use. The agent runs in tmux on your computer, exactly as if you had started it by hand. joy watches it, relays what it does to your phone and desktop, and types what you send back into the real session. Walk away from your desk and keep going: answer an approval from your phone, queue the next task from your laptop, stop a turn that went sideways, or pick up in the terminal where the agent left off.

## What you get

- **Your agents, anywhere.** Read a session live, send it a message, approve a tool call, or stop it, from iOS, Android, the web, or the macOS app.
- **Nothing stops when you leave.** Agents run on your machine, so closing the app or losing signal never touches them. Claude Code and Codex sessions live in tmux and outlive a daemon restart too. After a reboot, one command or one tap brings every session back into its conversation.
- **A queue you can trust.** Messages you send while an agent is busy wait their turn on the relay, in order, and survive restarts on either end. Edit or delete them before they run.
- **End-to-end encrypted.** Session content, titles, settings, and files are sealed on your devices, and the relay only stores and forwards ciphertext. Push notifications are the one exception, and they carry as little as possible; see [Security](docs/reference/security.md).
- **No service to sign up for.** joy has no default server. You run the relay, a single small Node process, or use one run by someone you trust.
- **Scriptable.** A `joy` command line, a local REST API on every machine, and an MCP server let scripts and agents start sessions, ask them questions, and talk to each other.
- **Automations.** Save a folder, a prompt, and a trigger, and joy runs it as its own session on demand, on a cron schedule, or after another automation finishes.

## How it fits together

```
 phone / web / desktop            relay (yours)                  your machine
┌──────────────────────┐   ┌────────────────────────┐   ┌───────────────────────────┐
│ joy app              │◄─►│ joy-relay              │◄─►│ joy daemon ──► tmux ──►   │
│ seals and opens      │   │ accounts, queue,       │   │ Claude Code, Codex,       │
│ everything you see   │   │ push, encrypted tunnel │   │ OpenCode, Pi              │
└──────────────────────┘   └────────────────────────┘   └───────────────────────────┘
```

- **[joy-app](packages/joy-app)** — the client, for iOS and Android (Expo), the web, and macOS (Tauri).
- **[joy-daemon](packages/joy-daemon)** — the daemon and the `joy` command line. One per machine. It starts and adopts agent sessions, reads their state, and bridges them to the relay.
- **[joy-relay](packages/joy-relay)** — the only server: accounts, machine pairing, the durable message queue, push notifications, and an end-to-end encrypted tunnel to each daemon.
- **[joy-mcp](packages/joy-mcp)** — an optional MCP server that gives the Claude app or Claude Code access to your sessions.

## Quick start

You need Node 22.13 or later, pnpm, and tmux on each machine that will run agents.

1. **Get a relay.** [Run your own](docs/getting-started/self-hosting.md), or get the address of one you trust.
2. **Open the app** at [joy.expo.app](https://joy.expo.app), enter the relay's address, and create an account. Save the backup code it shows you; it is the only way back into your account.
3. **Install the daemon** on your machine and pair it:

   ```bash
   CI=1 pnpm add -g "git+https://github.com/fny/joy.git#release&path:packages/joy-daemon"
   joy auth relay.example.com      # asks for your backup code
   joy install                     # start at login (systemd or launchd)
   joy doctor                      # check node, tmux, agents, pairing
   ```

4. **Start a session** from the app, or from the terminal:

   ```bash
   joy new ~/code/my-project -m "Run the tests and fix what fails"
   ```

The [install guide](docs/getting-started/install.md) walks through each step in detail.

## Documentation

The [documentation](docs/README.md) covers installing and self-hosting, every feature of the app, the command line, the MCP server, the security model, and troubleshooting.

## Development

This is a pnpm workspace. From the repository root:

```bash
pnpm install
```

Use the pnpm version pinned in every `package.json` (10.34.5). Dependency resolution
waits seven days after a version is published, including transitive dependencies.
Keep the committed lockfile and use `pnpm install --frozen-lockfile` for repeatable
builds; the age policy does not replace reviewing existing locked versions.
For an urgent, reviewed security fix, add only the specific package version to
`minimumReleaseAgeExclude` in `pnpm-workspace.yaml`, then remove the exception
once the release has aged seven days.

Standalone source installs with npm require npm 11.10.0 or later. The root and
each package carry a `.npmrc` with the same seven-day delay and `engine-strict`
enabled, so an older npm fails instead of ignoring the policy. Keep `.npmrc`
when copying a package for deployment. These are project install settings;
global installs outside the checkout need the same policy in the user's package
manager configuration.

| Package | Run | Check |
|---|---|---|
| `packages/joy-daemon` | `pnpm start` | `pnpm typecheck && pnpm test` |
| `packages/joy-relay` | `pnpm start` | `pnpm test`, and `pnpm sim` for the protocol simulator |
| `packages/joy-app` | `pnpm web`, `pnpm ios`, `pnpm android`, `pnpm tauri:dev` | `pnpm typecheck && pnpm test` |
| `packages/joy-mcp` | `pnpm start` | `pnpm test` |

The daemon runs straight from TypeScript with `tsx`, which does not type-check, so run `pnpm typecheck` before you trust a change. Each machine's daemon also serves its own API reference at `/docs` on its local port, and a relay serves its own at `/docs`.

joy began as a fork of [Happy Coder](https://github.com/slopus/happy) and is now its own system.

## License

GNU Affero General Public License v3.0. See [LICENSE](LICENSE).
