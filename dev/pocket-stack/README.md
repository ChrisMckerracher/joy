# Isolated Pocket test stack (Podman)

The web container serves an Expo export and proxies `/joy/v2` to a relay with
its own database volume. Pocket runs in the browser. The optional daemon has
its own home volume, pairing and agent login. Only the web port is published;
the daemon's control port and the relay stay inside the container network.

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
podman build --pull=never -t localhost/joy-pocket-daemon:dev -f dev/pocket-stack/Daemon.Containerfile dev/pocket-stack
bash dev/pocket-stack/up.sh /tmp/joy-pocket-web
```

Without that image, `up.sh` starts just web and relay. To reuse an already
installed standalone Codex executable, set `JOY_TEST_CODEX_BIN=/path/to/codex`
when first creating the daemon. Credentials are not copied from the host.

HTTP is available at http://agent-01:3210. Remote Pocket speech requires a secure
browser context. Private Tailscale Serve can supply HTTPS (enable Serve in the
tailnet first; do not use Funnel):

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:3210
```

On agent-01 this gives https://agent-01.taile7098d.ts.net:8443. Alternatively,
from the laptop run `ssh -N -L 3210:127.0.0.1:3210 agent-01` and visit
http://localhost:3210, which browsers treat as a secure context.

Create a test account in the web app. Pair the daemon using that account's
backup code in a terminal on the VM, then restart it to load the pairing:

```sh
podman exec -it joy-pocket-daemon node bin/joy.mjs auth http://joy-pocket-relay:3105
podman restart joy-pocket-daemon
podman exec -it joy-pocket-daemon codex login --device-auth
podman exec joy-pocket-daemon mkdir -p /home/node/workspace
```

Create a Codex session in the app on this machine with directory
`/home/node/workspace`. Enable spoken updates in a session. The first activation
downloads about 132 MB of models into the browser; subsequent use is cached.
This does not provide microphone transcription or spoken commands. Native
mobile testing still requires an installed development build on a device.

Inspect or stop the stack without deleting test data:

```sh
podman ps --filter name=joy-pocket
podman logs joy-pocket-relay
podman logs joy-pocket-daemon
podman stop joy-pocket-web joy-pocket-daemon joy-pocket-relay
tailscale serve --https=8443 off
```

The launcher starts existing containers without changing their mounts or port.
After changing those settings, stop and remove only the affected `joy-pocket-*`
container, then run the launcher again; named data volumes persist.
