// The phone in the NAT lab: a second device restored from the account's
// backup code, sitting behind its own NAT (hostb). It does what the app does:
// starts a session through the relay and talks to it, then punches a direct
// channel to the daemon. Then the relay dies, and the phone keeps working:
// checks the session, sends a message, reads the reply and a file the agent
// wrote, all over the punched channel. When the relay comes back, what was
// said while it was gone must be in the relay's history, in order.
//
// Driven by run.ts over stdio: one JSON object per stdout line. `{"need":…}`
// asks the driver to change the world (kill or restart the relay) and waits
// for "ok" on stdin; the last line is `{"report":…}`.
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { createInterface } from "node:readline";
// @ts-expect-error — plain ESM, no types
import { loginWithSecret, RelayClient } from "../../joy-mcp/src/relay.mjs";
// @ts-expect-error — plain ESM, no types
import { contentKeyPair, openSessionKeyEnvelope, openMachineKey, sealText, openPayload } from "../../joy-mcp/src/crypto.mjs";
import { tunnelFetch, connectDirect, type TunnelResponse } from "../src/tunnel/client";
import type { DirectTunnel } from "../src/tunnel/direct";

const RELAY = process.env.NATLAB_RELAY!;
const WORKDIR = process.env.NATLAB_WORKDIR!;
const MODE = process.env.NATLAB_MODE!; // cone | symmetric
const SCENARIO = process.env.NATLAB_SCENARIO ?? "outage"; // outage | subway
const secret = new Uint8Array(Buffer.from(process.env.NATLAB_SECRET!, "base64"));
const content = contentKeyPair(secret);
const marker = randomBytes(4).toString("hex");

const say = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
const stdin = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
async function need(what: string): Promise<void> {
  say({ need: what });
  const r = await stdin.next();
  if (r.done || r.value.trim() !== "ok") throw new Error(`driver refused ${what}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, ms: number, probe: () => Promise<T | null | undefined | false>): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown = null;
  for (;;) {
    try { const v = await probe(); if (v) return v; } catch (e) { last = e; }
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}${last ? ` (last error: ${last instanceof Error ? last.message : String(last)})` : ""}`);
    await sleep(250);
  }
}

interface Step { name: string; ok: boolean; ms: number; detail?: unknown; error?: string }
const steps: Step[] = [];
async function step<T>(name: string, fn: () => Promise<T>, detail?: (v: T) => unknown): Promise<T> {
  const t0 = Date.now();
  try {
    const v = await fn();
    const s: Step = { name, ok: true, ms: Date.now() - t0, ...(detail ? { detail: detail(v) } : {}) };
    steps.push(s); say({ step: s });
    return v;
  } catch (e) {
    const s: Step = { name, ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
    steps.push(s); say({ step: s });
    throw e;
  }
}

/** Text of a relay event payload: a prompt, or an agent text record. */
function textOf(p: any): string | null {
  if (!p) return null;
  if (p.t === "record") {
    const c = p.record?.content;
    // A prompt the daemon mirrored (one sent over the tunnel, not the queue).
    if (c?.type === "text" && typeof c.text === "string") return c.text;
    const ev = c?.data?.ev;
    return ev?.t === "text" && typeof ev.text === "string" ? ev.text : null;
  }
  return typeof p.text === "string" ? p.text : null;
}

async function main(): Promise<void> {
  const { token } = await step("phone signs in with the backup code", () => loginWithSecret(RELAY, secret));
  const relay = new RelayClient({ relayUrl: RELAY, token, renew: async () => (await loginWithSecret(RELAY, secret)).token });

  const machine = await step("daemon is online through the relay", () => until("an active machine", 30_000, async () => {
    const { machines } = await relay.listMachines();
    return (machines as any[]).find((m) => m.active || m.leaseAlive) ?? null;
  }), (m: any) => ({ machineId: m.id }));
  const machineKey: Uint8Array = openMachineKey(machine.dataEncryptionKey, content.secretKey);
  if (!machineKey) throw new Error("machine key did not open with the account's content key");
  const target = { relayUrl: RELAY, accountToken: token, masterSecret: machineKey, machineId: machine.id as string };

  // ── A session, created and used through the relay, as the app does ──────
  const created = await step("session created through the relay", async () => {
    const { sessionId } = await relay.createSession(machine.id, JSON.stringify({ v: 1, t: "spawn", cwd: WORKDIR, agent: "agy", createDir: true }));
    await until("the daemon to bind the session", 30_000, async () => {
      const s = await relay.sessionState(sessionId);
      if (s.spawnFailure) throw new Error(`spawn failed: ${JSON.stringify(s.spawnFailure)}`);
      return s.sessionState && s.sessionState !== "provisioning";
    });
    const { sessions } = await relay.listSessions();
    const row = (sessions as any[]).find((r) => r.sessionId === sessionId);
    const key = openSessionKeyEnvelope(row?.sessionKeyEnvelope, content.secretKey);
    if (!key) throw new Error("session key envelope did not open");
    return { sessionId: sessionId as string, local: row.localSessionId as string, key: key as Uint8Array };
  }, (c) => ({ sessionId: c.sessionId, localSessionId: c.local }));

  const relayTexts = async (): Promise<Array<{ seq: number; text: string }>> => {
    const out: Array<{ seq: number; text: string }> = [];
    let after = 0;
    for (;;) {
      const page = await relay.events(created.sessionId, { after, limit: 500 });
      for (const m of page.messages as any[]) {
        const t = textOf(openPayload(m.content?.ciphertext, created.key));
        // The relay sends seq as a string (a bigint column).
        if (t !== null) out.push({ seq: Number(m.seq), text: t });
        after = Math.max(after, Number(m.seq));
      }
      if (!page.hasMore) return out;
    }
  };

  const m1 = `m1 ${marker}`;
  const firstReply = await step("message and reply through the relay", async () => {
    await relay.sendCiphertext(created.sessionId, sealText(m1, created.key));
    return until("the agent's reply in relay history", 30_000, async () =>
      (await relayTexts()).find((e) => e.text.startsWith("re: ") && e.text.includes(m1)));
  }, (r) => ({ seq: r.seq }));

  // ── Punch ────────────────────────────────────────────────────────────────
  let direct: DirectTunnel | null = null;
  const punched = await step(`direct channel attempt (${MODE} NAT)`, async () => {
    try {
      direct = await connectDirect(target, { timeoutMs: 15_000, log: (l) => process.stderr.write(`${new Date().toISOString()} ${l}\n`) });
      return { punched: true, pair: direct.selectedPair() };
    } catch (e) {
      return { punched: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }, (v) => v);

  const call = (method: string, path: string, body?: unknown, useDirect = true, onChunk?: (c: Uint8Array) => void): Promise<TunnelResponse> => tunnelFetch({
    ...target, method, path, direct: useDirect ? direct : null, onChunk,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(body)) }),
  });
  const json = (r: TunnelResponse) => JSON.parse(new TextDecoder().decode(r.body) || "null");

  if (SCENARIO === "subway") {
    if (!punched.punched) throw new Error(`no direct channel to download over: ${punched.reason}`);
    await subway(call, json, created.local);
    return;
  }

  if (!punched.punched) {
    // Hard NAT: no direct path. Everything must still work, over the relay.
    await step("session check falls back to the relay", async () => {
      const r = await call("GET", `/v2/sessions/${created.local}/check`);
      if (r.via !== "relay" || r.status !== 200) throw new Error(`via ${r.via}, status ${r.status}`);
      return json(r);
    }, (j) => ({ state: j?.state }));
    const m2 = `m2 ${marker}`;
    await step("message and reply still go through the relay", async () => {
      await relay.sendCiphertext(created.sessionId, sealText(m2, created.key));
      return until("the reply", 30_000, async () => (await relayTexts()).find((e) => e.text.startsWith("re: ") && e.text.includes(m2)));
    }, (r) => ({ seq: r.seq }));
    return;
  }

  await step("session check over the direct channel", async () => {
    const r = await call("GET", `/v2/sessions/${created.local}/check`);
    if (r.via !== "direct" || r.status !== 200) throw new Error(`via ${r.via}, status ${r.status}`);
    return json(r);
  }, (j) => ({ state: j?.state }));

  // ── The relay dies ───────────────────────────────────────────────────────
  await need("relay_down");
  await step("relay is unreachable", async () => {
    const reachable = await fetch(`${RELAY}/joy/v2/capabilities`, { signal: AbortSignal.timeout(3_000) }).then(() => true, () => false);
    if (reachable) throw new Error("the relay still answers");
    const viaRelay = await call("GET", `/v2/sessions/${created.local}/check`, undefined, false).then(() => "answered", (e) => `failed: ${e.message}`);
    if (viaRelay === "answered") throw new Error("a relay-only request still got an answer");
    return viaRelay;
  }, (v) => ({ relayOnlyRequest: v }));

  await step("session check with the relay down", async () => {
    const r = await call("GET", `/v2/sessions/${created.local}/check`);
    if (r.via !== "direct" || r.status !== 200) throw new Error(`via ${r.via}, status ${r.status}`);
    const j = json(r);
    if (j?.state !== "idle") throw new Error(`state ${j?.state}`);
    return j;
  }, (j) => ({ state: j.state }));

  const m2 = `m2 ${marker}`;
  await step("send a message with the relay down", async () => {
    const r = await call("POST", "/v2/send", { session_id: created.local, text: m2, from: "app" });
    const j = json(r);
    if (r.via !== "direct" || r.status !== 200 || j?.ok === false || j?.error) throw new Error(`via ${r.via}, status ${r.status}, ${JSON.stringify(j)}`);
    return j;
  }, (j) => ({ queuedId: j?.queued_id ?? null }));

  await step("read the reply with the relay down", () => until("the agent's reply on the daemon", 30_000, async () => {
    const r = await call("GET", `/sessions/${created.local}/events?after=0`);
    if (r.via !== "direct") throw new Error(`via ${r.via}`);
    const line = new TextDecoder().decode(r.body).split("\n").find((l) => l.includes("re: ") && l.includes(m2));
    return line ? { found: true } : null;
  }), (v) => v);

  await step("read a file the agent wrote, with the relay down", async () => {
    const r = await call("GET", `/v2/sessions/${created.local}/files/content?path=turns.log`);
    const j = json(r);
    const text = Buffer.from(String(j?.content ?? ""), "base64").toString("utf8");
    if (r.via !== "direct" || !text.includes(m1) || !text.includes(m2)) throw new Error(`via ${r.via}, turns.log: ${JSON.stringify(text)}`);
    return text.split(marker).length - 1; // one per turn; a prompt sent over the tunnel spans several lines (<joy-message …>)
  }, (turns) => ({ turnsLogged: turns }));

  // ── The relay comes back ─────────────────────────────────────────────────
  await need("relay_up");
  const relayUpAt = Date.now();
  const describeHistory = async (): Promise<string> => {
    const lines: string[] = [];
    let after = 0;
    for (;;) {
      const page = await relay.events(created.sessionId, { after, limit: 500 });
      for (const m of page.messages as any[]) {
        const p = openPayload(m.content?.ciphertext, created.key);
        const r = p?.record;
        lines.push(`${m.seq} ${m.kind} ${p?.t ?? "?"}${r ? ` role=${r.role} type=${r.content?.type} ${JSON.stringify(r.content).slice(0, 160)}` : p?.text ? ` ${JSON.stringify(p.text).slice(0, 80)}` : ""}`);
        after = Math.max(after, Number(m.seq));
      }
      if (!page.hasMore) return lines.join("\n");
    }
  };
  await step("the offline conversation reaches relay history, in order", () => until("m2 and its reply in relay history", 90_000, async () => {
    const texts = await relayTexts();
    const prompt = texts.find((e) => !e.text.startsWith("re: ") && e.text.includes(m2));
    const reply = texts.find((e) => e.text.startsWith("re: ") && e.text.includes(m2));
    if (!prompt || !reply) { if (Date.now() - relayUpAt > 85_000) throw new Error(`history so far:\n${await describeHistory()}`); return null; }
    if (!(firstReply.seq < prompt.seq && prompt.seq < reply.seq)) throw new Error(`out of order: m1 reply ${firstReply.seq}, m2 ${prompt.seq}, m2 reply ${reply.seq}`);
    return { promptSeq: prompt.seq, replySeq: reply.seq };
  }), (v) => v);

  const m3 = `m3 ${marker}`;
  await step("message and reply through the relay again", async () => {
    await until("the daemon back on the relay", 60_000, async () => {
      const { machines } = await relay.listMachines();
      return (machines as any[]).some((m) => m.id === machine.id && (m.active || m.leaseAlive));
    });
    await relay.sendCiphertext(created.sessionId, sealText(m3, created.key), randomUUID());
    return until("the reply", 60_000, async () => (await relayTexts()).find((e) => e.text.startsWith("re: ") && e.text.includes(m3)));
  }, (r) => ({ seq: r.seq }));

  await step("the direct channel survived the outage", async () => {
    const r = await call("GET", `/v2/sessions/${created.local}/check`);
    if (r.via !== "direct") throw new Error(`via ${r.via}`);
    return r.status;
  }, (s) => ({ status: s }));
}

/** A 50 MB file, asked for the moment the phone goes underground and
 *  delivered while its link climbs back through one bar to LTE (run.ts
 *  shapes it). Then the same file through the relay on street signal. */
async function subway(
  call: (method: string, path: string, body?: unknown, useDirect?: boolean, onChunk?: (c: Uint8Array) => void) => Promise<TunnelResponse>,
  json: (r: TunnelResponse) => any,
  local: string,
): Promise<void> {
  const name = process.env.NATLAB_BIGFILE!;
  const want = process.env.NATLAB_BIGFILE_SHA256!;
  const download = async (useDirect: boolean) => {
    const t0 = Date.now();
    let got = 0;
    const progress = setInterval(() => process.stderr.write(`${new Date().toISOString()} [progress ${useDirect ? "direct" : "relay"}] ${(got / 1e6).toFixed(1)} MB after ${((Date.now() - t0) / 1000).toFixed(0)} s\n`), 5_000);
    const r = await call("GET", `/v2/sessions/${local}/files/content?path=${encodeURIComponent(name)}`, undefined, useDirect, (c) => { got += c.length; })
      .finally(() => clearInterval(progress));
    const seconds = (Date.now() - t0) / 1000;
    const j = json(r);
    if (r.status !== 200 || j?.success === false) throw new Error(`status ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
    const bytes = Buffer.from(String(j.content), "base64");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== want) throw new Error(`sha256 mismatch: got ${sha256}, want ${want} (${bytes.length} bytes)`);
    return { via: r.via, fileBytes: bytes.length, wireBytes: r.body.length, seconds, wireMbps: Number(((r.body.length * 8) / seconds / 1e6).toFixed(2)), sha256ok: true };
  };

  await step("session check before going underground", async () => {
    const r = await call("GET", `/v2/sessions/${local}/check`);
    if (r.via !== "direct") throw new Error(`via ${r.via}`);
    return r.status;
  });
  await need("subway_exit");
  await step("50 MB file over the direct channel while leaving the subway", async () => {
    const d = await download(true);
    if (d.via !== "direct") throw new Error(`fell back to ${d.via}`);
    return d;
  }, (d) => d);
  await step("the direct channel is still up after the download", async () => {
    const r = await call("GET", `/v2/sessions/${local}/check`);
    if (r.via !== "direct") throw new Error(`via ${r.via}`);
    return r.status;
  });
  await step("the same 50 MB file through the relay, on street signal", () => download(false), (d) => d);
}

main().then(
  () => { say({ report: { mode: MODE, ok: steps.every((s) => s.ok), steps } }); process.exit(0); },
  (e) => { say({ report: { mode: MODE, ok: false, steps, error: e instanceof Error ? e.message : String(e) } }); process.exit(1); },
);
