// The NAT lab's driver. Runs in lab.sh's "internet" namespace and plays the
// world around the phone (phone.ts):
//   - the relay, a real `joy-relay` process at 192.0.2.1 with STUN on :3478
//   - agent-01, a real daemon process behind NAT A (hosta), paired with
//     `joy auth` and a backup code on stdin, running the stand-in agy agent
//   - the phone, behind NAT B (hostb)
// When the phone asks, the relay is SIGKILLed (a host that just dies) and
// later restarted on the same data directory.
//
// Writes the phone's report to NATLAB_REPORT and exits with the phone's code.
// Logs of every process land in NATLAB_LOGS.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { createInterface } from "node:readline";

const MODE = process.env.NATLAB_MODE ?? "cone";
/** outage: the relay dies mid-session. subway: a 50 MB download while the
 *  phone's own link goes from nothing to bad to decent. */
const SCENARIO = process.env.NATLAB_SCENARIO ?? "outage";
const REPORT = process.env.NATLAB_REPORT!;
const ROOT = resolve(import.meta.dirname, "../../..");
const DAEMON_PKG = join(ROOT, "packages/joy-daemon");
const RELAY_IP = "192.0.2.1";
const RELAY = `http://${RELAY_IP}:8080`;
const base = mkdtempSync(join(tmpdir(), "joy-natlab-"));
const LOGS = process.env.NATLAB_LOGS ?? join(base, "logs");
mkdirSync(LOGS, { recursive: true });
const relayData = join(base, "relay-data");
const daemonHome = join(base, "agent-01-home");
const workdir = join(daemonHome, "work");
mkdirSync(daemonHome, { recursive: true });

// Every lab process starts from a clean environment: a JOY_* variable from
// whoever launched the lab (a relay URL, a home dir) or a test runner's
// VITEST/NODE_ENV must not leak into the relay, the daemon or `joy auth`.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("JOY_") && !k.startsWith("VITEST") && k !== "NODE_ENV" && k !== "TMUX" && k !== "TMUX_PANE")) as Record<string, string>;
const children = new Set<ChildProcess>();
function run(name: string, argv: string[], env: Record<string, string> = {}): ChildProcess {
  const log = createWriteStream(join(LOGS, `${name}.log`), { flags: "a" });
  const child = spawn(argv[0], argv.slice(1), { cwd: ROOT, env: { ...cleanEnv, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout!.on("data", (d) => log.write(d));
  child.stderr!.on("data", (d) => log.write(d));
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}
function waitFor(child: ChildProcess, stream: "stdout" | "stderr", pattern: RegExp, ms: number, what: string): Promise<void> {
  return new Promise((ok, fail) => {
    let seen = "";
    const t = setTimeout(() => fail(new Error(`${what}: no ${pattern} within ${ms} ms`)), ms);
    const on = (d: Buffer) => { seen += d.toString(); if (pattern.test(seen)) { clearTimeout(t); child[stream]!.off("data", on); ok(); } };
    child[stream]!.on("data", on);
    child.once("exit", (code) => { clearTimeout(t); fail(new Error(`${what}: exited ${code} before ${pattern}`)); });
  });
}
const inHost = (ns: string, argv: string[]) => ["ip", "netns", "exec", ns, ...argv];

// The phone's link, shaped with netem on both sides of NAT B: `upb` (this
// namespace → NAT B) is the phone's downlink, `wanb` (NAT B → here) its
// uplink. Coming up out of the subway: nothing, then one bar, then LTE.
const PROFILES: Record<string, { down: string; up: string } | null> = {
  underground: { down: "loss 100%", up: "loss 100%" },
  station: { down: "delay 250ms 80ms loss 3% rate 2mbit", up: "delay 250ms 80ms loss 3% rate 512kbit" },
  street: { down: "delay 60ms 15ms loss 0.5% rate 12mbit", up: "delay 60ms 15ms loss 0.5% rate 5mbit" },
  clear: null,
};
const timeline: Array<{ atMs: number; profile: string }> = [];
const labStart = Date.now();
function shape(profile: string): void {
  const p = PROFILES[profile];
  const tc = (ns: string | null, dev: string, netem: string | null) => {
    const argv = [...(ns ? ["ip", "netns", "exec", ns] : []), "tc", "qdisc", ...(netem === null ? ["del", "dev", dev, "root"] : ["replace", "dev", dev, "root", "netem", ...netem.split(" ")])];
    try { execFileSync(argv[0], argv.slice(1), { stdio: "ignore" }); }
    catch (e) { if (netem !== null) throw e; /* nothing to clear */ }
  };
  tc(null, "upb", p?.down ?? null);
  tc("natb", "wanb", p?.up ?? null);
  timeline.push({ atMs: Date.now() - labStart, profile });
  process.stderr.write(`[natlab ${MODE}] phone link → ${profile}\n`);
}
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

let relay: ChildProcess | null = null;
async function startRelay(): Promise<void> {
  relay = run("relay", ["node", "packages/joy-relay/server.mjs"], {
    JOY_RELAY_DATA_DIR: relayData, JOY_RELAY_HOST: RELAY_IP, JOY_RELAY_PORT: "8080", JOY_RELAY_DOCS: "off",
    JOY_RELAY_STUN_PORT: "3478", JOY_RELAY_STUN_HOST: RELAY_IP,
  });
  await waitFor(relay, "stdout", /\[joy-relay\] listening/, 30_000, "relay");
}
async function killRelay(): Promise<void> {
  const r = relay!;
  const gone = new Promise((ok) => r.once("exit", ok));
  r.kill("SIGKILL");
  await gone;
  relay = null;
}

async function main(): Promise<number> {
  await startRelay();

  // The account: a backup code, as the app's first device would create.
  const secret = randomBytes(32);
  const backupCode = secret.toString("base64url");

  // agent-01 behind NAT A: pair with the backup code on stdin, then run.
  const daemonEnv = { HOME: daemonHome, JOY_HOME_DIR: daemonHome, TMUX_TMPDIR: join(daemonHome, "tmux") };
  mkdirSync(daemonEnv.TMUX_TMPDIR, { recursive: true });
  const auth = run("joy-auth", inHost("hosta", ["env", ...Object.entries(daemonEnv).map(([k, v]) => `${k}=${v}`), "node", join(DAEMON_PKG, "bin/joy.mjs"), "auth", RELAY]));
  auth.stdin!.end(backupCode + "\n");
  const authCode = await new Promise<number | null>((ok) => auth.once("exit", ok));
  if (authCode !== 0) throw new Error(`joy auth exited ${authCode}`);

  const daemon = run("daemon", inHost("hosta", ["env", "-u", "TMUX", "-u", "TMUX_PANE",
    ...Object.entries({ ...daemonEnv, JOY_RELAY_URL: RELAY, PORT: "4997", TMUX_SESSION: "joy-natlab", PATH: `${join(DAEMON_PKG, "natlab/bin")}:${cleanEnv.PATH}` }).map(([k, v]) => `${k}=${v}`),
    "node", "--import", "tsx", join(DAEMON_PKG, "src/server.ts")]));
  await waitFor(daemon, "stderr", /\[direct\] direct tunnel enabled/, 60_000, "daemon");

  // subway: a 50 MB file of noise in the session's folder on agent-01.
  const bigFile = { name: "subway-50mb.bin", sha256: "" };
  if (SCENARIO === "subway") {
    mkdirSync(workdir, { recursive: true });
    const bytes = randomBytes(50 * 1024 * 1024);
    writeFileSync(join(workdir, bigFile.name), bytes);
    bigFile.sha256 = createHash("sha256").update(bytes).digest("hex");
  }

  // The phone behind NAT B.
  const phone = run("phone", inHost("hostb", ["env",
    `NATLAB_RELAY=${RELAY}`, `NATLAB_WORKDIR=${workdir}`, `NATLAB_MODE=${MODE}`, `NATLAB_SECRET=${secret.toString("base64")}`,
    `NATLAB_SCENARIO=${SCENARIO}`, `NATLAB_BIGFILE=${bigFile.name}`, `NATLAB_BIGFILE_SHA256=${bigFile.sha256}`,
    "node", "--import", "tsx", join(DAEMON_PKG, "natlab/phone.ts")]));
  let report: unknown = null;
  const lines = createInterface({ input: phone.stdout! });
  lines.on("line", (line) => {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.step) process.stderr.write(`[natlab ${MODE}] ${msg.step.ok ? "ok  " : "FAIL"} ${msg.step.name} (${msg.step.ms} ms)${msg.step.ok ? "" : ` — ${msg.step.error}`}\n`);
    if (msg.report) report = msg.report;
    if (msg.need === "relay_down") void killRelay().then(() => phone.stdin!.write("ok\n"), (e) => { process.stderr.write(`kill relay: ${e}\n`); phone.stdin!.write("no\n"); });
    if (msg.need === "relay_up") void startRelay().then(() => phone.stdin!.write("ok\n"), (e) => { process.stderr.write(`start relay: ${e}\n`); phone.stdin!.write("no\n"); });
    if (msg.need === "subway_exit") {
      // Underground now; the phone starts its download straight away. One bar
      // at the station exit after 8 s, street LTE 20 s after that.
      shape("underground");
      phone.stdin!.write("ok\n");
      void (async () => { await sleepMs(8_000); shape("station"); await sleepMs(20_000); shape("street"); })();
    }
  });
  const code = await new Promise<number | null>((ok) => phone.once("exit", ok));
  writeFileSync(REPORT, JSON.stringify({ ...(report as object ?? { mode: MODE, ok: false, steps: [], error: `phone exited ${code} without a report` }), scenario: SCENARIO, timeline }, null, 2));
  return code ?? 1;
}

const deadline = setTimeout(() => { process.stderr.write("natlab: overall deadline passed\n"); for (const c of children) c.kill("SIGKILL"); process.exit(3); }, Number(process.env.NATLAB_DEADLINE_MS ?? 240_000));
main().then(
  (code) => { clearTimeout(deadline); for (const c of children) c.kill("SIGTERM"); process.stderr.write(`natlab logs: ${LOGS}\n`); setTimeout(() => process.exit(code), 500); },
  (e) => {
    clearTimeout(deadline);
    process.stderr.write(`natlab: ${e instanceof Error ? e.message : String(e)}\nnatlab logs: ${LOGS}\n`);
    if (REPORT) writeFileSync(REPORT, JSON.stringify({ mode: MODE, ok: false, steps: [], error: e instanceof Error ? e.message : String(e) }));
    for (const c of children) c.kill("SIGKILL");
    setTimeout(() => process.exit(2), 500);
  },
);
