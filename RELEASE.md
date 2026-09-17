# Releasing joy

Four things deploy independently, by four different mechanisms:

| Piece | Reaches users by | Version file |
|---|---|---|
| joy-daemon | a branch push, then `joy update` on each machine | `packages/joy-daemon/package.json` |
| the app, on phones | an EAS build, then an over-the-air update | `packages/joy-app/app.config.js` |
| the app, on desktop and web | an export, then a deploy to the hosted site | same as above |
| the relay and the MCP server | one rsync-and-restart script | `packages/joy-relay/package.json`, `packages/joy-mcp/package.json` |

Nothing here runs automatically. Every release is deliberate, and none of it
happens without explicit permission for that specific deploy.

## Before any release

1. **A clean working tree.** Several agent sessions edit this repo at once, and
   the relay script rsyncs the working tree rather than a commit. An unrelated
   half-finished edit will ship with it. Stage selectively and commit first.
2. **`pnpm typecheck`** in the package you touched. `tsx` runs TypeScript
   without checking it, so a type error ships as a runtime crash.
3. **`npx vitest run`** for the affected suites.
4. **A changelog entry** in `packages/joy-app/CHANGELOG.md` when the change is
   user-visible. That file is the in-app What's New feed. `pnpm ota` validates
   it before publishing, so a malformed entry stops the release.
5. **Bump the version** of the piece you are shipping (see below).

## Versions

Bump the patch version of a package whenever you release it. The number is not
decoration: the daemon reads its own `package.json` at startup and publishes it
as machine metadata, and the app compares that against a minimum. A version
that never moves makes the app unable to tell a daemon built today from one
hundreds of commits behind.

```bash
cd packages/joy-daemon && npm version patch --no-git-tag-version
```

Two things to know:

- **The app has two version fields and only one is live.** `app.config.js` is
  the one that ships and the one Settings shows. `packages/joy-app/package.json`
  has a version too, and nothing reads it.
- **`runtimeVersion` is not a version bump.** It is the native compatibility
  fence, and it only moves when the native surface changes. Raising it strands
  every build in the field until a new binary exists at the new number.

## The daemon

```bash
git push origin main:release          # publish
joy update                            # on each machine
```

Machines install from the `release` branch, so a push is the release and
`joy update` is how each machine takes it. Bump first, or the machines cannot
tell they changed.

**Verify** with `joy status` on each machine: the version should be the one you
just bumped to. A machine whose daemon runs from a source checkout instead
updates with `git pull` and `joy restart`.

## The app

Channels, branches and build profiles are covered in
[packages/joy-app/RELEASE.md](packages/joy-app/RELEASE.md). What matters here
is the order of operations and what ships with what.

```bash
pnpm release                 # menu: builds and over-the-air updates
pnpm ota                     # preview branch, then the desktop bundle
pnpm ota:edge                # the edge branch, phones only
pnpm ota:production          # the production workflow
```

- **Desktop and mobile ship together** for preview and production. The desktop
  app loads the hosted bundle, so `pnpm ota` publishes both in one command.
  Edge is deliberately phones-only, since there is no desktop edge target.
- **Mind the runtime fence.** Builds in the field may sit at an older runtime
  than the config's default. Publishing at the wrong number sends an update
  where nothing can see it. Check with `eas channel:view <channel>` first.
- **A new Android package must be registered** in the Firebase project and
  `google-services.json` re-downloaded, or the build fails outright.

**Verify** with `eas channel:view <channel>`, and in the app under
Settings, where the JS Update row names the bundle actually running.

## The relay and the MCP server

```bash
packages/joy-relay/infra/deploy.sh          # both relays
packages/joy-relay/infra/deploy.sh dev      # the dev relay only
packages/joy-relay/infra/deploy.sh mcp      # the MCP server only
```

This is the one piece that verifies itself: the script probes the relay's
capabilities endpoint after restarting and fails loudly if it does not answer.
It is idempotent and safe to rerun. Host and key come from environment
overrides documented at the top of the script.

## Order

When a change spans pieces, ship in dependency order:

1. **The relay first.** Both the daemon and the app talk to it.
2. **The daemon next.** An app update that needs new daemon behaviour will
   quietly do nothing on a machine that has not updated. Changelog entries say
   "needs the updated daemon" exactly for this.
3. **The app last**, so it never reaches a phone before what it depends on.

## Undoing a release

- **The app**: `eas update:rollback` points a branch back at its previous
  update, `eas update:republish` puts a known-good one back, and
  `eas channel:pause` stops serving a channel entirely.
- **The daemon**: push the previous commit to `release` and run `joy update`
  again. There is no separate artifact to roll back.
- **The relay**: rerun the script from the previous commit. It is a full rsync,
  so it restores whatever the tree holds.

## Machine notes

- One machine in the fleet runs the daemon from a source checkout. It takes a
  restart, not `joy update`, and running `joy update` there would convert it to
  a global install and rewrite its service.
- Restarting a daemon can leave the old process holding the port. Check what is
  listening before assuming the new one bound.
- On macOS, the service's PATH is captured from whichever shell ran the install.
  Install from a shell that can see the agent binaries, or the daemon comes back
  unable to find them.
- A daemon restart is safe for running sessions. They live in tmux and are
  recovered, though anything reading the session at that moment sees a blink.
