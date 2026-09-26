# Isolated Joy development stack (Podman)

The `joy-pocket-*` container and volume identifiers are retained so existing
accounts, pairing and test data remain usable. They run the ordinary Joy stack.

The web container serves an Expo export and proxies `/joy/v2` to a relay with
its own database volume. Pocket runs in the browser. The optional daemon has
its own home volume, pairing and agent login. Only web ports are published;
the daemon's control port and the relay stay inside the container network.
Containers use Podman's init process to reap orphaned tmux children; without
it, an active daemon can eventually exhaust the container's process limit.

This developer setup reuses an existing checkout and its installed Linux
`node_modules` through read-only mounts. It does not install JS dependencies.
Export the current web app first:

```sh
cd packages/joy-app
../../node_modules/.bin/expo export --platform web --output-dir /tmp/joy-pocket-web
cd ../..
```

With permission to install tmux, Git and their runtime dependencies inside an
image, build the daemon (the cached Node image must already be available):

```sh
podman build --pull=never -t localhost/joy-pocket-daemon:dev -f dev/stack/Daemon.Containerfile dev/stack
bash dev/stack/up.sh /tmp/joy-pocket-web
```

Without that image, `up.sh` starts just web and relay. To reuse an already
installed standalone Codex executable, set `JOY_TEST_CODEX_BIN=/path/to/codex`
when first creating the daemon. Credentials are not copied from the host.

HTTP is available at http://agent-01:3210. Remote Pocket speech requires a secure
browser context. The gateway can serve HTTPS directly, with a local certificate
for `agent-01`. No Tailscale Serve or additional packages are needed:

```sh
JOY_TEST_VM_IP=10.77.0.182 bash dev/stack/make-cert.sh /tmp/joy-pocket-direct-tls
# Recreate just the stateless web container to add the TLS port and secret mount.
podman stop joy-pocket-web
podman rm joy-pocket-web
JOY_TEST_VM_IP=10.77.0.182 JOY_TEST_TLS_DIR=/tmp/joy-pocket-direct-tls bash dev/stack/up.sh /tmp/joy-pocket-web
```

Copy `/tmp/joy-pocket-direct-tls/ca.crt` to the laptop (for example with `scp`)
and import it as a trusted certificate authority in the browser's certificate
settings. Then open https://agent-01:3443. Trusting the CA avoids certificate
warnings and enables Pocket's model verification API; clicking through a warning
is not the supported setup. The server certificate lasts 90 days. Regenerate in
a new directory and recreate the web container when it expires. Keep the CA
signing key private; only the server's leaf key enters the container, as a
Podman secret. `JOY_TEST_HTTPS_PORT` overrides the default 3443.

When the browser runs on the VM host, use the VM's private address directly:
https://10.77.0.182:3443 for the current agent-01 VM. `JOY_TEST_VM_IP` adds that
address to the certificate and exact host allowlist; substitute the VM's actual
private address if it changes. Alternatively, map `agent-01` to that private IP
in the host's hosts file. The laptop maps `agent-01` to `100.121.220.10` through Tailscale.
Keep Tailscale connected when accessing the VM from the laptop.

Alternatively, from the laptop run `ssh -N -L 3210:127.0.0.1:3210 agent-01` and
visit http://localhost:3210, which browsers treat as a secure context. Browser
accounts and model caches are stored per origin, so choose one URL for testing.

Create a test account in the web app. A fresh daemon does not appear in the
machine picker until paired. Run this on the VM, then open the printed link
in the same browser origin where you are logged in and accept the connection:

```sh
podman exec joy-pocket-daemon node --import tsx /repo/dev/stack/pair-daemon.mjs https://10.77.0.182:3443 && podman restart joy-pocket-daemon
```

The helper uses Joy's existing terminal approval protocol and proof of key
possession, waits up to ten minutes, and refuses to overwrite an existing
pairing. It is intended for this isolated, initially ungated test relay. If
using a static relay gate, set `JOY_RELAY_ACCESS_KEY` in the daemon too.

Alternatively, pair with your account backup code at the CLI prompt. Agent
login is separate from Joy pairing:

```sh
podman exec -it joy-pocket-daemon node bin/joy.mjs auth http://joy-pocket-relay:3105
podman restart joy-pocket-daemon
podman exec -it joy-pocket-daemon codex login --device-auth
podman exec joy-pocket-daemon mkdir -p /home/node/workspace
```

Create a Codex session in the app on this machine with directory
`/home/node/workspace`. Explicitly choose **Codex** in the new-session agent
selector: Joy defaults to Claude, but this image does not install Claude. The
Codex executable must be mounted as described above and `codex login status`
inside the container must report a login before testing replies. Choosing an
uninstalled agent can leave messages queued while its startup fails.

Configure Voice and tap the microphone in a session. The first activation
downloads about 132 MB of models into the browser; subsequent use is cached.
The gateway enables cross-origin isolation for up to four WASM CPU threads.
Playback waits for each complete clip to avoid mid-word gaps when inference is slower than real time.
Configure the conversation and transcription endpoints in Settings → Voice, then
test spoken instructions, summaries, questions and approvals. Native testing
still requires an installed development build on a device. Speakerphone echo
and real-device interruption behavior remain validation requirements.

Inspect or stop the stack without deleting test data:

```sh
podman ps --filter name=joy-pocket
podman logs joy-pocket-relay
podman logs joy-pocket-daemon
podman stop joy-pocket-web joy-pocket-daemon joy-pocket-relay
```

The launcher starts existing containers without changing their mounts or port.
After changing those settings, stop and remove only the affected `joy-pocket-*`
container, then run the launcher again; named data volumes persist.
