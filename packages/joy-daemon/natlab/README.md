# NAT lab

Real processes behind real NATs, for testing direct (hole-punched) tunnels.
`lab.sh` builds two home networks behind NAT routers plus an "internet" in
unprivileged namespaces (`unshare -rnm`), with `ip`, `nft` and `tc` only. It
needs no root and touches nothing outside the namespaces.

```
hosta 10.1.0.2 (agent-01: real daemon) ── nata ── 198.51.100.2 ┐
                                                               ├─ internet: relay + STUN at 192.0.2.1
hostb 10.2.0.2 (the phone)             ── natb ── 203.0.113.2  ┘
```

- `run.ts` starts a real `joy-relay` with STUN, pairs a real daemon with
  `joy auth` behind NAT A, runs `phone.ts` behind NAT B, and changes the
  world when the phone asks: it SIGKILLs and restarts the relay, or shapes
  the phone's link with netem.
- `phone.ts` does what the app does: signs in with the backup code, creates
  a session through the relay, talks to it, punches a direct channel, and
  checks each step. It prints one JSON line per step and a final report.
- `bin/agy` is a stand-in agent: it answers `re: <prompt>` and logs every
  prompt to `turns.log` in the session folder.

Scenarios (`NATLAB_SCENARIO`):

| Scenario | What happens |
|---|---|
| `outage` (default) | The relay dies mid-session. Check, send, reply and a file read keep working over the direct channel; afterwards the relay history holds what was said, in order. |
| `subway` | A 50 MB file is requested as the phone goes underground: no signal for 8 s, then 2 Mbit/s with 250 ms ± 80 ms and 3% loss for 20 s, then 12 Mbit/s with 60 ms ± 15 ms and 0.5% loss. It must arrive intact over the direct channel. The same file then goes through the relay for comparison. |

NAT modes (`lab.sh cone|symmetric`): `cone` behaves like a home router
(ports kept, only replies let in), so punching works. `symmetric` picks a
random port per flow, like much carrier-grade NAT, so punching must fail and
the relay carries everything.

Run from the repository root:

```bash
NATLAB_MODE=cone NATLAB_REPORT=/tmp/report.json \
  unshare -rnm --propagation private -- \
  bash packages/joy-daemon/natlab/lab.sh cone -- node --import tsx packages/joy-daemon/natlab/run.ts
```

The vitest wrapper is `src/tunnel/direct.natlab.e2e.test.ts`; the subway
test runs only with `JOY_NATLAB_SUBWAY=1`.
