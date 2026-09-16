# Release channels and builds

One word per channel, and the same word in every place: the `eas.json` build
profile, the EAS channel, the EAS branch, and the bundle id suffix. Nothing then
needs a mapping table, and `eas channel:view <word>` tells the whole story.

| Word | Build profile | Bundle id | App name | Who it is for |
|---|---|---|---|---|
| `development` | dev client, needs Metro | `vip.faraz.joy.dev` | Joy (dev) | Native work. See the warning below: updates do not apply on their own here. |
| `edge` | standalone, internal | `vip.faraz.joy.edge` | Joy (edge) | Risky JS tried on a real device. Silent updates. Installs beside preview. |
| `preview` | standalone, internal + TestFlight | `vip.faraz.joy.preview` | Joy | The everyday build. |
| `production` | store | `vip.faraz.joy` | Joy | App Store. Its channel points at the `preview` branch server-side. |

## How a build finds its updates

`app.config.js` derives `updateChannel` from `APP_ENV` and sends it as the
`expo-channel-name` request header. That header **overrides** the channel EAS
bakes in from the build profile, so the two must agree. A preview build once
shipped polling `production` while updates went to `preview`, and no update ever
arrived (2026-07-05). Until 2026-09-16 the header collapsed every non-production
variant to `preview`, which is why a per-variant channel was impossible.

An update also has to clear the runtime version fence. `runtimeVersion` is the
native surface's number, and an update only reaches a binary carrying the same
number. `JOY_RUNTIME_VERSION` overrides it at publish time, which is how JS
reaches binaries already in the field when the fence has moved past them.

> **Development builds do not update themselves.** A dev client is a debug
> build. expo-updates does not poll there, and `useUpdates` returns early under
> `__DEV__`, so Settings → Check for updates fails too. Published bundles are
> still reachable: the dev launcher lists the project's branches, and you load
> one by hand. Publish to `development` for that, not for delivery.

## Commands

```bash
pnpm release:build:edge     # build the edge binary, both platforms
pnpm ota:edge               # publish JS to the edge branch (mobile only)
pnpm ota                    # publish to the preview branch, then the desktop bundle
pnpm ota:production         # the production workflow
```

Never publish without explicit permission for that specific publish.

`ota:edge` is mobile only on purpose. The desktop app loads one hosted bundle
from `joy.expo.app`, so there is no desktop edge target. The rule that desktop
and mobile ship together applies to preview and production.

## Adding a channel

1. `eas channel:create <word>` creates the channel and links the branch of the
   same name.
2. Add the build profile to `eas.json` with `"channel": "<word>"` and an
   `APP_ENV` of the same word. Leave `developmentClient` off, or the build will
   not update itself.
3. Add the word to the `name`, `bundleId`, `consoleLoggingDefault` and
   `updateChannel` maps in `app.config.js`.
4. Register the Android package in the `joy-coder` Firebase project and
   re-download `google-services.json`. The Gradle plugin fails the build on a
   package the file does not list. It currently carries
   `vip.faraz.joy.preview` and `vip.faraz.joy.edge`.
5. Build once. Nothing published to a channel reaches anything until a binary
   exists on it.

## Undoing a bad update

```bash
eas update:rollback                 # point the branch back at the previous update
eas update:republish --group <id>   # publish a known-good update again
eas channel:pause --channel <word>  # stop serving that channel
```

A device that already downloaded the bad bundle picks up the correction on its
next launch.
