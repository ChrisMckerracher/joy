// Direct tunnel (direct.ts), in one process over loopback: a real WebRTC
// channel between a DirectTunnel and a DirectServer, a real local HTTP
// surface behind it, and a stand-in relay that forwards sealed exchanges the
// way the real one does (executeSealed on the far side). Covers the framing,
// signalling through the tunnel, streaming, the shared replay guard and the
// fallback to the relay. The NAT lab (direct.natlab.e2e.test.ts) covers the
// same thing as separate processes behind real NATs.
import { test, expect, beforeAll, afterAll, describe } from "vitest";
import * as http from "node:http";
import { randomBytes } from "node:crypto";
import { encodeFrame, decodeFrame, framesFor, FRAME_PAYLOAD_MAX, createDirectServer, type DirectServer, type DirectTunnel } from "./direct";
import { executeSealed, type SealedDispatch } from "./executor";
import { SeenStreamIds } from "./replayGuard";
import { deriveTunnelKey } from "./sealedStream";
import { sealRequest, openHeadAndBody, requestBinding, type ResponseHead } from "./wire";
import { tunnelFetch, connectDirect } from "./client";

describe("framing", () => {
  test("a frame round-trips kind, id, FIN and payload", () => {
    const p = randomBytes(1000);
    const f = decodeFrame(encodeFrame(2, 0xfffffffe, true, p))!;
    expect(f).toMatchObject({ kind: 2, id: 0xfffffffe, fin: true });
    expect(Buffer.compare(Buffer.from(f.payload), p)).toBe(0);
    expect(decodeFrame(new Uint8Array(3))).toBeNull();
    expect(decodeFrame(encodeFrame(9 as never, 1, false))).toBeNull();
  });

  test("an exchange splits at the payload cap and FINs only its last frame", () => {
    const bytes = randomBytes(FRAME_PAYLOAD_MAX * 2 + 10);
    const frames = [...framesFor(1, 7, bytes, true)].map((f) => decodeFrame(f)!);
    expect(frames.map((f) => [f.payload.length, f.fin])).toEqual([[FRAME_PAYLOAD_MAX, false], [FRAME_PAYLOAD_MAX, false], [10, true]]);
    expect(Buffer.compare(Buffer.concat(frames.map((f) => f.payload)), bytes)).toBe(0);
    expect([...framesFor(1, 7, new Uint8Array(0), true)].map((f) => decodeFrame(f)!.fin)).toEqual([true]);
    expect([...framesFor(1, 7, new Uint8Array(0), false)]).toEqual([]);
  });
});

const MACHINE = "m-direct-test";
const machineKey = new Uint8Array(32).fill(9);
const key = deriveTunnelKey(machineKey, MACHINE);
const BIG = randomBytes(5 * 1024 * 1024);

let local: http.Server; let localUrl = "";
let relay: http.Server; let relayUrl = "";
let server: DirectServer;
let relayExchanges = 0;
const seen = new SeenStreamIds();

beforeAll(async () => {
  const dispatch: SealedDispatch = { key, seen, targetBase: () => localUrl, targetHeaders: { "x-joy-token": "t" }, log: () => {} };
  server = createDirectServer({ dispatch, config: async () => ({ iceServers: [] }) });

  // The daemon's local surface: what every tunneled request lands on.
  local = http.createServer((req, res) => {
    if (req.url === "/echo") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ hello: "direct" })); return; }
    if (req.url === "/big") { res.writeHead(200, { "content-type": "application/octet-stream" }); res.end(BIG); return; }
    if (req.method === "POST" && req.url === "/v2/direct/offer") {
      let body = ""; req.on("data", (d) => { body += d; });
      req.on("end", () => {
        if (req.headers["x-joy-token"] !== "t") { res.writeHead(401); res.end(); return; }
        // As the real /v2/direct/offer route answers (transports/v2.ts).
        void server.answer(JSON.parse(body).sdp).then(
          (sdp) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ sdp })); },
          (e) => { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "direct_failed", detail: String(e) })); },
        );
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => local.listen(0, "127.0.0.1", r));
  localUrl = `http://127.0.0.1:${(local.address() as any).port}`;

  // A stand-in relay: POST /joy/v2/machines/:id/http runs the sealed request
  // through executeSealed and streams the sealed response back, as the real
  // relay + executor pair does.
  relay = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (d) => parts.push(d));
    req.on("end", () => {
      relayExchanges++;
      res.writeHead(200, { "content-type": "application/octet-stream" });
      void executeSealed(dispatch, Buffer.concat(parts), async (bytes, done) => { res.write(bytes); if (done) res.end(); }, "relay");
    });
  });
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
  relayUrl = `http://127.0.0.1:${(relay.address() as any).port}`;
});

afterAll(async () => {
  server.close();
  await new Promise((r) => local.close(r));
  await new Promise((r) => relay.close(r));
});

const target = () => ({ relayUrl, accountToken: "tok", masterSecret: machineKey, machineId: MACHINE });

describe("a punched channel", () => {
  let direct: DirectTunnel;
  beforeAll(async () => {
    direct = await connectDirect(target(), { iceServers: [], timeoutMs: 10_000 });
  }, 20_000);
  afterAll(() => direct.close());

  test("is signalled through the relay tunnel, then carries exchanges itself", async () => {
    expect(direct.open).toBe(true);
    expect(direct.selectedPair()?.local.type).toBe("host");
    const before = relayExchanges;
    const r = await tunnelFetch({ ...target(), method: "GET", path: "/echo", direct });
    expect(r.via).toBe("direct");
    expect(r.status).toBe(200);
    expect(JSON.parse(new TextDecoder().decode(r.body))).toEqual({ hello: "direct" });
    expect(relayExchanges).toBe(before); // nothing touched the relay
  });

  test("streams a 5 MiB response intact", async () => {
    const r = await tunnelFetch({ ...target(), method: "GET", path: "/big", direct });
    expect(r.via).toBe("direct");
    expect(r.body.length).toBe(BIG.length);
    expect(Buffer.compare(Buffer.from(r.body), BIG)).toBe(0);
  }, 20_000);

  test("runs many exchanges at once without mixing their responses", async () => {
    const rs = await Promise.all(Array.from({ length: 20 }, () => tunnelFetch({ ...target(), method: "GET", path: "/echo", direct })));
    expect(rs.every((r) => r.via === "direct" && r.status === 200)).toBe(true);
  });

  test("a request the daemon refuses fails fast instead of waiting for an answer", async () => {
    const t0 = Date.now();
    // Over the 32 MiB request cap: never dispatched, aborted back to us. A
    // write is not retried through the relay, so this surfaces as an error.
    await expect(tunnelFetch({ ...target(), method: "POST", path: "/echo", direct, body: new Uint8Array(33 * 1024 * 1024) }))
      .rejects.toMatchObject({ code: "connection_lost" });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(direct.open).toBe(true); // one refused exchange does not cost the channel
    expect((await tunnelFetch({ ...target(), method: "GET", path: "/echo", direct })).via).toBe("direct");
  }, 20_000);

  test("shares the replay guard with the relay path: a request the relay carried does not run again", async () => {
    const wire = sealRequest(key, { m: "GET", p: "/echo", h: {}, t: Date.now() }, new Uint8Array(0));
    const viaRelay = await fetch(`${relayUrl}/joy/v2/machines/${MACHINE}/http`, { method: "POST", body: wire });
    expect(openHeadAndBody<ResponseHead>(key, new Uint8Array(await viaRelay.arrayBuffer()), requestBinding(wire)).head.s).toBe(200);
    const replayed = new Uint8Array(await new Response(direct.exchange(wire)).arrayBuffer());
    const { head } = openHeadAndBody<ResponseHead>(key, replayed, requestBinding(wire));
    expect(head.s).toBe(409);
    expect(head.h["x-tunnel-error"]).toBe("replayed_request");
  });
});

test("once the channel is closed, the same call goes through the relay", async () => {
  const direct = await connectDirect(target(), { iceServers: [], timeoutMs: 10_000 });
  direct.close();
  expect(direct.open).toBe(false);
  const before = relayExchanges;
  const r = await tunnelFetch({ ...target(), method: "GET", path: "/echo", direct });
  expect(r.via).toBe("relay");
  expect(r.status).toBe(200);
  expect(relayExchanges).toBe(before + 1);
}, 20_000);

test("a daemon without direct support is a clean refusal, not a hang", async () => {
  const saved = server.answer;
  server.answer = async () => { throw new Error("off"); };
  try {
    await expect(connectDirect(target(), { iceServers: [], timeoutMs: 5_000 })).rejects.toThrow();
  } finally { server.answer = saved; }
}, 20_000);
