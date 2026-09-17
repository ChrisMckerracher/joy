// A session whose runtime dies with the machine (reboot: its per-session tmux
// server is gone) is BOUND by refreshBindings and then ARCHIVED by
// reconcileOrphans in that same boot pass — with no card publisher wired,
// because it had no live handle at that moment.
//
// When the user resumed it, nothing ever re-wired one: announceLocalSession
// returned at the door (already bound), announceUnboundSessions skipped it for
// the same reason, and reconcileOrphans only ever examines `active`/`starting`
// rows. The relay row stayed `archived` and the app refused to open the
// session until the daemon was restarted (metal.voltai.party, 2026-09-17).
//
// Announcing a bound-but-live session now wires its card publisher, whose
// immediate republish carries the live state (cardStateFor: running → active).
import { it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { startNucleusLane, type NucleusLaneHandle } from "./nucleusLane";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

process.env.JOY_HOME_DIR = mkdtempSync(joinPath(tmpdir(), "joy-lane-archived-resume-"));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) { if (Date.now() > deadline) throw new Error("timeout waiting"); await sleep(50); }
}

/** Scripted relay: serves the session list and applies PATCHed states to it. */
function makeFakeRelay(rows: any[]) {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const path = req.url!.replace(/^\/joy\/v2/, "");
      const method = req.method!;
      const send = (obj: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (path === "/daemon/leases") return send({ leaseId: "L1", leaseToken: "T1", epoch: 1 });
      if (/^\/daemon\/leases\/[^/]+$/.test(path) && method === "PUT") return send({ ok: true });
      if (path.endsWith("/claims/work")) return send({ offers: [] });
      if (path.endsWith("/claims/control")) return send({ offers: [] });
      if (path === "/sessions" && method === "GET") return send({ sessions: rows });
      calls.push({ method, path, body });
      if (method === "PATCH" && path === "/daemon/sessions/row1" && typeof body.state === "string") {
        const row = rows.find((r) => r.sessionId === "row1");
        if (row) row.state = body.state;
      }
      send({ ok: true });
    });
  });
  return {
    server, calls,
    listen: () => new Promise<string>((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as any).port}`))),
    states: () => calls.filter((c) => c.method === "PATCH" && c.path === "/daemon/sessions/row1").map((c) => c.body.state).filter(Boolean),
  };
}

let handle: NucleusLaneHandle | null = null;
let srv: http.Server | null = null;
afterEach(async () => { await handle?.stop(); handle = null; srv?.close(); srv = null; });

it("resuming a session whose row the boot sweep archived publishes its card again, without a daemon restart", async () => {
  // The row is live on the relay and bound to a local session that has NO
  // runtime yet — exactly the state after a reboot took its tmux server.
  const rows: any[] = [{ sessionId: "row1", daemonId: "m", localSessionId: "s1", state: "active" }];
  const relay = makeFakeRelay(rows);
  srv = relay.server;
  const url = await relay.listen();

  let live: any = undefined;
  const records = [{ id: "s1", v2SessionId: "row1", socket: null, launchCwd: "/tmp/x" }];
  let announce!: (s: any) => Promise<void>;
  const registry: any = {
    get: (id: string) => (id === "s1" ? live : undefined),
    list: () => (live ? [live] : []),
    listRecords: () => records,
    chatHistory: () => [],
    saveRecord: () => {},
    setAnnouncer: (f: any) => { announce = f; },
  };

  handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m", log: () => {} });
  await until(() => !!handle?.currentLease());
  // The boot pass binds the row, finds no runtime behind it, and archives it.
  await until(() => rows[0].state === "archived");
  expect(relay.states()).toEqual(["archived"]);

  // The user taps the session: the daemon resumes it in a fresh tmux server,
  // and restart() announces the replacement.
  live = { id: "s1", status: "active", cwd: "/tmp/x", cardMetadata: () => ({ joy__state: "running" }) };
  await announce(live);

  // The card publisher was wired and republished: the row is live again.
  await until(() => rows[0].state === "active", 5_000);
  expect(relay.states()).toEqual(["archived", "active"]);
}, 20_000);
