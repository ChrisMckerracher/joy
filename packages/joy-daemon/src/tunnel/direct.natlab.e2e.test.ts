// The relay as a hole puncher, end to end, as separate processes behind
// real NATs (natlab/): a real relay with STUN, a real daemon paired with
// `joy auth` behind NAT A, and a phone client behind NAT B.
//
// Scenario: Chris starts a session from his phone and talks to it through
// the relay as usual. The phone punches a direct channel to agent-01. Then
// the relay's host dies (SIGKILL). Chris keeps working: he checks the
// session, sends a message, reads the agent's reply and a file it wrote, all
// over the punched channel. The relay comes back; what was said while it was
// gone is in the relay's history, in order, and the relay path works again.
//
// With symmetric NAT on both sides the punch cannot work: the same session
// must then simply keep using the relay.
//
// Subway (opt-in, JOY_NATLAB_SUBWAY=1, ~10 min): the phone asks agent-01 for
// a 50 MB file the moment it goes underground; its link then climbs from
// nothing (8 s) to one bar (2 Mbit/s, 250 ms ± 80 ms, 3% loss; 20 s) to
// street LTE (12 Mbit/s, 60 ms ± 15 ms, 0.5% loss). The file must arrive
// intact, over the direct channel, which must still be up afterwards.
//
// Needs unprivileged user + network namespaces (unshare -rn), `ip` and `nft`;
// skipped where they are missing. Nothing outside the namespaces is touched.
import { test, expect, describe } from "vitest";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PKG = resolve(import.meta.dirname, "../..");
const ROOT = resolve(PKG, "../..");

const labAvailable = (() => {
  if (process.platform !== "linux") return false;
  const probe = spawnSync("unshare", ["-rnm", "--propagation", "private", "sh", "-c", "ip link add t0 type veth peer name t1 && nft list tables"], { stdio: "ignore" });
  return probe.status === 0;
})();

interface Step { name: string; ok: boolean; ms: number; detail?: any; error?: string }
interface Report { mode: string; ok: boolean; steps: Step[]; error?: string }

function runLab(mode: "cone" | "symmetric", scenario: "outage" | "subway" = "outage", deadlineMs = 240_000): Promise<{ code: number | null; report: Report; log: string }> {
  const dir = mkdtempSync(join(tmpdir(), `joy-natlab-${mode}-`));
  const reportPath = join(dir, "report.json");
  return new Promise((done) => {
    let log = "";
    const child = spawn("unshare", ["-rnm", "--propagation", "private", "--", "bash", join(PKG, "natlab/lab.sh"), mode, "--",
      "node", "--import", "tsx", join(PKG, "natlab/run.ts")], {
      cwd: ROOT, env: { ...process.env, NATLAB_MODE: mode, NATLAB_SCENARIO: scenario, NATLAB_DEADLINE_MS: String(deadlineMs), NATLAB_REPORT: reportPath, NATLAB_LOGS: join(dir, "logs") },
    });
    child.stderr.on("data", (d) => { log += d; });
    child.stdout.on("data", (d) => { log += d; });
    child.on("exit", (code) => {
      let report: Report;
      try { report = JSON.parse(readFileSync(reportPath, "utf8")); } catch { report = { mode, ok: false, steps: [], error: "no report" }; }
      done({ code, report, log });
    });
  });
}

const stepNamed = (r: Report, name: string) => r.steps.find((s) => s.name === name);

describe.skipIf(!labAvailable)("NAT lab: the relay as a hole puncher", () => {
  test("cone NAT: punched; the relay dies; the session keeps working; history catches up", async () => {
    const { code, report, log } = await runLab("cone");
    const failed = report.steps.filter((s) => !s.ok).map((s) => `${s.name}: ${s.error}`);
    expect(failed, log).toEqual([]);
    expect(report.ok, `${report.error ?? ""}\n${log}`).toBe(true);
    expect(code).toBe(0);

    // A real punch: both ends are NAT public addresses, never the private
    // hosts (the lab's internet has no route between those).
    const attempt = stepNamed(report, "direct channel attempt (cone NAT)")!;
    expect(attempt.detail.punched).toBe(true);
    expect(["srflx", "prflx"]).toContain(attempt.detail.pair.local.type);
    expect(["srflx", "prflx"]).toContain(attempt.detail.pair.remote.type);
    expect(attempt.detail.pair.local.address).toBe("203.0.113.2");   // NAT B, the phone's side
    expect(attempt.detail.pair.remote.address).toBe("198.51.100.2"); // NAT A, agent-01's side

    for (const name of [
      "relay is unreachable",
      "session check with the relay down",
      "send a message with the relay down",
      "read the reply with the relay down",
      "read a file the agent wrote, with the relay down",
      "the offline conversation reaches relay history, in order",
      "message and reply through the relay again",
      "the direct channel survived the outage",
    ]) expect(stepNamed(report, name)?.ok, name).toBe(true);
    expect(stepNamed(report, "read a file the agent wrote, with the relay down")!.detail.turnsLogged).toBe(2);
  }, 240_000);

  test("symmetric NAT: no punch is possible, and the relay carries everything", async () => {
    const { code, report, log } = await runLab("symmetric");
    expect(report.steps.filter((s) => !s.ok).map((s) => `${s.name}: ${s.error}`), log).toEqual([]);
    expect(code).toBe(0);
    expect(stepNamed(report, "direct channel attempt (symmetric NAT)")!.detail.punched).toBe(false);
    expect(stepNamed(report, "session check falls back to the relay")?.ok).toBe(true);
    expect(stepNamed(report, "message and reply still go through the relay")?.ok).toBe(true);
  }, 240_000);

  test.skipIf(process.env.JOY_NATLAB_SUBWAY !== "1")("subway exit: a 50 MB file arrives intact over the direct channel while the link recovers", async () => {
    const { code, report, log } = await runLab("cone", "subway", 1_500_000);
    expect(report.steps.filter((s) => !s.ok).map((s) => `${s.name}: ${s.error}`), log).toEqual([]);
    expect(code).toBe(0);
    const direct = stepNamed(report, "50 MB file over the direct channel while leaving the subway")!;
    expect(direct.detail).toMatchObject({ via: "direct", fileBytes: 50 * 1024 * 1024, sha256ok: true });
    expect(stepNamed(report, "the direct channel is still up after the download")?.ok).toBe(true);
    const relayed = stepNamed(report, "the same 50 MB file through the relay, on street signal")!;
    expect(relayed.detail).toMatchObject({ via: "relay", fileBytes: 50 * 1024 * 1024, sha256ok: true });
  }, 1_600_000);
});
