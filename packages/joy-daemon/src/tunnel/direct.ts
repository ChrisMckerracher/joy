// Direct tunnel: the same sealed exchanges the relay forwards
// (/machines/{id}/http → executor), carried instead over a WebRTC data
// channel punched straight between the client and this daemon. The relay's
// only jobs are STUN (each side learns its public address) and carrying the
// offer/answer — inside the ordinary sealed tunnel, so it can neither read
// nor swap the DTLS fingerprints that pin the channel to the two ends.
//
// Nothing about the exchange changes: the client seals the same request wire,
// the daemon runs the same executeSealed (open → replay/stale guard → local
// path check → dispatch → sealed, bound response), and the client opens the
// same response. The channel is just a pipe; if it cannot be punched, or
// dies, the client keeps using the relay.
//
// Framing on the channel ("joy-tunnel", ordered + reliable):
//   frame = kind u8 ‖ exchange id u32 BE ‖ flags u8 ‖ payload
//   kind  : 1 = request bytes (client → daemon), 2 = response bytes
//           (daemon → client), 3 = cancel (client → daemon, no payload),
//           4 = abort (daemon → client, no payload: this exchange will get
//           no more bytes; the client treats it as a cut stream)
//   flags : bit 0 = FIN (last frame of this exchange's bytes)
// Payloads are slices of the sealed wire, so framing adds no crypto of its own.
import type { DataChannel, PeerConnection } from "node-datachannel";
import { executeSealed, type SealedDispatch } from "./executor";

/** The native WebRTC stack, loaded on first use: a platform without a
 *  prebuilt binary still runs the daemon, and simply never punches (every
 *  exchange stays on the relay). */
async function webrtc(): Promise<typeof import("node-datachannel").default> {
  return (await import("node-datachannel")).default;
}

export const CHANNEL_LABEL = "joy-tunnel";
const KIND_REQUEST = 1;
const KIND_RESPONSE = 2;
const KIND_CANCEL = 3;
const KIND_ABORT = 4;
const FLAG_FIN = 1;
const FRAME_HEADER = 6;
/** Well under the 256 KiB SCTP message size every WebRTC stack accepts. */
export const FRAME_PAYLOAD_MAX = 64 * 1024 - FRAME_HEADER;
/** Pause writes above this much queued on the channel; resume when it drains. */
const HIGH_WATER = 1024 * 1024;
const GATHER_TIMEOUT_MS = 5_000;
const OPEN_TIMEOUT_MS = 10_000;
/** Sealed request cap, the relay tunnel's own (joy-relay src/tunnel.mjs). */
const REQUEST_MAX = 32 * 1024 * 1024;
/** Exchanges one channel may have in flight (arriving or answering). */
const EXCHANGES_MAX = 64;

export interface DirectFrame { kind: number; id: number; fin: boolean; payload: Uint8Array }

export function encodeFrame(kind: number, id: number, fin: boolean, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (payload.length > FRAME_PAYLOAD_MAX) throw new Error("frame payload too large");
  const out = new Uint8Array(FRAME_HEADER + payload.length);
  const v = new DataView(out.buffer);
  v.setUint8(0, kind);
  v.setUint32(1, id >>> 0);
  v.setUint8(5, fin ? FLAG_FIN : 0);
  out.set(payload, FRAME_HEADER);
  return out;
}

export function decodeFrame(msg: Uint8Array): DirectFrame | null {
  if (msg.length < FRAME_HEADER) return null;
  const v = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  const kind = v.getUint8(0);
  if (kind !== KIND_REQUEST && kind !== KIND_RESPONSE && kind !== KIND_CANCEL && kind !== KIND_ABORT) return null;
  return { kind, id: v.getUint32(1), fin: (v.getUint8(5) & FLAG_FIN) !== 0, payload: msg.subarray(FRAME_HEADER) };
}

/** Split `bytes` into frames of one exchange; the last one carries FIN when
 *  `done`. An empty final piece still sends one (empty) FIN frame. */
export function* framesFor(kind: number, id: number, bytes: Uint8Array, done: boolean): Generator<Uint8Array> {
  if (bytes.length === 0) { if (done) yield encodeFrame(kind, id, true); return; }
  for (let off = 0; off < bytes.length; off += FRAME_PAYLOAD_MAX) {
    const end = Math.min(off + FRAME_PAYLOAD_MAX, bytes.length);
    yield encodeFrame(kind, id, done && end === bytes.length, bytes.subarray(off, end));
  }
}

const toBytes = (msg: string | Buffer | ArrayBuffer): Uint8Array | null =>
  typeof msg === "string" ? null : msg instanceof ArrayBuffer ? new Uint8Array(msg) : new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength);

/** Writes that wait while the channel's send queue is above HIGH_WATER, so a
 *  large file or a chatty SSE stream paces the sender instead of growing its
 *  memory. Throws once the channel is closed: the exchange is over. */
class ChannelWriter {
  #dc: DataChannel;
  #waiters: Array<() => void> = [];
  constructor(dc: DataChannel) {
    this.#dc = dc;
    dc.setBufferedAmountLowThreshold(HIGH_WATER / 2);
    dc.onBufferedAmountLow(() => { const w = this.#waiters; this.#waiters = []; for (const f of w) f(); });
  }
  wakeAll(): void { const w = this.#waiters; this.#waiters = []; for (const f of w) f(); }
  async send(frame: Uint8Array): Promise<void> {
    while (this.#dc.isOpen() && this.#dc.bufferedAmount() > HIGH_WATER) {
      await new Promise<void>((r) => this.#waiters.push(r));
    }
    if (!this.#dc.isOpen()) throw new Error("direct channel closed");
    // false = queued behind earlier frames, not refused (libdatachannel's
    // send answers "sent immediately?"); the high-water wait above bounds it.
    this.#dc.sendMessageBinary(frame);
  }
}

function waitGathered(pc: PeerConnection, timeoutMs: number): Promise<void> {
  if (pc.gatheringState() === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, timeoutMs); // send what we have: host candidates at least
    pc.onGatheringStateChange((s) => { if (s === "complete") { clearTimeout(t); resolve(); } });
  });
}

export interface DirectConfig {
  /** e.g. ["stun:relay.example.com:3478"]; empty = host candidates only. */
  iceServers: string[];
  /** Pin ICE to a UDP port range (a firewall or `podman run -p` rule). */
  portRange?: { begin: number; end: number };
}

/** ICE servers for a relay: JOY_ICE_SERVERS (comma-separated) wins; else the
 *  relay's advertised STUN port on the relay's own host; else none. */
export async function iceServersFor(relayUrl: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const env = process.env.JOY_ICE_SERVERS?.trim();
  if (env) return env.split(",").map((s) => s.trim()).filter(Boolean);
  try {
    const r = await fetchImpl(`${relayUrl.replace(/\/$/, "")}/joy/v2/capabilities`, { signal: AbortSignal.timeout(5_000) });
    const caps = await r.json() as { stun?: { port?: number } };
    const port = caps?.stun?.port;
    if (typeof port !== "number") return [];
    const host = new URL(relayUrl).hostname;
    return [`stun:${host.includes(":") ? `[${host}]` : host}:${port}`];
  } catch { return []; }
}

/** JOY_DIRECT_PORT_RANGE="50000-50100" → { begin, end }. */
export function portRangeFromEnv(): { begin: number; end: number } | undefined {
  const m = /^(\d+)-(\d+)$/.exec(process.env.JOY_DIRECT_PORT_RANGE?.trim() ?? "");
  if (!m) return undefined;
  const begin = Number(m[1]); const end = Number(m[2]);
  return begin > 0 && end >= begin && end < 65536 ? { begin, end } : undefined;
}

// ── daemon side ────────────────────────────────────────────────────────────

export interface DirectServerOpts {
  dispatch: SealedDispatch;
  /** Resolved per offer, so a relay that starts advertising STUN is used. */
  config: () => Promise<DirectConfig>;
  maxPeers?: number;
}

export interface DirectServer {
  /** Answer one client's offer (arrived sealed, over the relay tunnel). */
  answer(offerSdp: string): Promise<string>;
  peers(): number;
  close(): void;
}

export function createDirectServer(opts: DirectServerOpts): DirectServer {
  const maxPeers = opts.maxPeers ?? 16;
  const peers = new Set<PeerConnection>();
  const log = opts.dispatch.log;

  function drop(pc: PeerConnection): void {
    if (!peers.delete(pc)) return;
    try { pc.close(); } catch { /* already closed */ }
  }

  function serve(pc: PeerConnection, dc: DataChannel): void {
    if (dc.getLabel() !== CHANNEL_LABEL) { dc.close(); return; }
    const writer = new ChannelWriter(dc);
    const inbound = new Map<number, { parts: Uint8Array[]; bytes: number }>();
    const running = new Set<number>();   // dispatched, response not finished
    const cancelled = new Set<number>(); // subset of running the client gave up on
    const refused = new Set<number>();   // over a cap: frames still arriving are dropped
    const abort = (id: number) => { if (dc.isOpen()) dc.sendMessageBinary(encodeFrame(KIND_ABORT, id, true)); };
    dc.onClosed(() => { log("[direct] channel closed"); writer.wakeAll(); drop(pc); });
    dc.onError((e) => log(`[direct] channel error: ${e}`));
    dc.onMessage((msg) => {
      const bytes = toBytes(msg);
      const f = bytes && decodeFrame(bytes);
      if (!f) return;
      if (f.kind === KIND_CANCEL) {
        inbound.delete(f.id);
        if (running.has(f.id)) cancelled.add(f.id);
        return;
      }
      if (f.kind !== KIND_REQUEST) return;
      if (refused.has(f.id)) { if (f.fin) refused.delete(f.id); return; }
      let acc = inbound.get(f.id);
      if (!acc) {
        if (inbound.size + running.size >= EXCHANGES_MAX) { refuse(f.id, f.fin, "too many exchanges in flight"); return; }
        acc = { parts: [], bytes: 0 };
        inbound.set(f.id, acc);
      }
      acc.bytes += f.payload.length;
      if (acc.bytes > REQUEST_MAX) { inbound.delete(f.id); refuse(f.id, f.fin, "request too large"); return; }
      acc.parts.push(new Uint8Array(f.payload)); // copy: the native buffer is not ours past this callback
      if (!f.fin) return;
      inbound.delete(f.id);
      running.add(f.id);
      const id = f.id;
      const emit = async (out: Uint8Array, done: boolean) => {
        if (cancelled.has(id)) throw new Error("exchange cancelled");
        for (const frame of framesFor(KIND_RESPONSE, id, out, done)) await writer.send(frame);
      };
      void executeSealed(opts.dispatch, Buffer.concat(acc.parts), emit, `direct:${id}`)
        .catch((e) => {
          log(`direct exchange ${id}: ${e instanceof Error ? e.message : String(e)}`);
          // Tell the client this exchange is over, or it waits for a FIN that
          // never comes. (If the channel itself is gone, the client sees that.)
          if (!cancelled.has(id)) abort(id);
        })
        .finally(() => { running.delete(id); cancelled.delete(id); });
    });
    /** Never dispatched: say so now, and drop the rest of its frames. */
    function refuse(id: number, fin: boolean, why: string): void {
      log(`direct exchange ${id}: refused (${why})`);
      if (!fin) refused.add(id);
      abort(id);
    }
  }

  return {
    async answer(offerSdp: string): Promise<string> {
      const cfg = await opts.config();
      while (peers.size >= maxPeers) drop(peers.values().next().value!); // oldest first
      const pc = new (await webrtc()).PeerConnection("joy-daemon", {
        iceServers: cfg.iceServers,
        ...(cfg.portRange ? { portRangeBegin: cfg.portRange.begin, portRangeEnd: cfg.portRange.end } : {}),
      });
      peers.add(pc);
      // A peer whose channel never opens (the punch failed) is reaped.
      const reap = setTimeout(() => drop(pc), OPEN_TIMEOUT_MS * 3);
      pc.onDataChannel((dc) => { clearTimeout(reap); serve(pc, dc); });
      pc.onStateChange((s) => {
        if (s === "connected") {
          const pair = pc.getSelectedCandidatePair();
          if (pair) log(`[direct] peer connected ${pair.local.type} ${pair.local.address}:${pair.local.port} ⇄ ${pair.remote.type} ${pair.remote.address}:${pair.remote.port}`);
        }
        else log(`[direct] peer ${s}`);
        if (s === "failed" || s === "closed") { clearTimeout(reap); drop(pc); }
      });
      pc.setRemoteDescription(offerSdp, "offer");
      await waitGathered(pc, GATHER_TIMEOUT_MS);
      const local = pc.localDescription();
      if (!local || local.type !== "answer") { drop(pc); throw new Error("no local answer"); }
      return local.sdp;
    },
    peers: () => peers.size,
    close() { for (const pc of [...peers]) drop(pc); },
  };
}

/** The daemon's one server, published for the /v2/direct/offer route. */
let current: DirectServer | null = null;
export function setDirectServer(s: DirectServer | null): void { current = s; }
export function directServer(): DirectServer | null { return current; }

// ── client side ────────────────────────────────────────────────────────────

export interface DirectConnectOpts {
  config: DirectConfig;
  /** Carry our offer to the daemon and return its answer: the sealed relay
   *  tunnel, POST /v2/direct/offer. Only used while connecting. */
  signal: (offerSdp: string) => Promise<string>;
  timeoutMs?: number;
  /** Channel lifecycle (state changes, close, errors) — rare lines. */
  log?: (line: string) => void;
}

export interface CandidateEnd { type: string; address: string; port: number }

/** One punched channel to one daemon. `exchange` carries a sealed request
 *  wire and yields the sealed response bytes, exactly as the relay's
 *  /machines/{id}/http response body would. */
export class DirectTunnel {
  #pc: PeerConnection;
  #dc: DataChannel;
  #writer: ChannelWriter;
  #nextId = 1;
  #pending = new Map<number, ReadableStreamDefaultController<Uint8Array>>();
  #closed = false;

  private constructor(pc: PeerConnection, dc: DataChannel, log: (line: string) => void) {
    this.#pc = pc; this.#dc = dc;
    this.#writer = new ChannelWriter(dc);
    dc.onMessage((msg) => {
      const bytes = toBytes(msg);
      const f = bytes && decodeFrame(bytes);
      if (!f || (f.kind !== KIND_RESPONSE && f.kind !== KIND_ABORT)) return;
      const c = this.#pending.get(f.id);
      if (!c) return;
      if (f.kind === KIND_ABORT) { this.#pending.delete(f.id); c.error(new Error("direct exchange aborted by the daemon")); return; }
      if (f.payload.length > 0) c.enqueue(new Uint8Array(f.payload));
      if (f.fin) { this.#pending.delete(f.id); c.close(); }
    });
    const fail = () => this.#teardown(new Error("direct channel closed"));
    dc.onClosed(() => { log("[direct] channel closed"); fail(); });
    dc.onError((e) => log(`[direct] channel error: ${e}`));
    // "disconnected" is not an end: consent checks lapse in a tunnel or a
    // lift and come back when the signal does. Only ICE giving up ("failed")
    // or a close ends the channel; until then exchanges wait it out.
    pc.onStateChange((s) => { log(`[direct] peer ${s}`); if (s === "failed" || s === "closed") fail(); });
  }

  static async connect(opts: DirectConnectOpts): Promise<DirectTunnel> {
    const pc = new (await webrtc()).PeerConnection("joy-client", {
      iceServers: opts.config.iceServers,
      ...(opts.config.portRange ? { portRangeBegin: opts.config.portRange.begin, portRangeEnd: opts.config.portRange.end } : {}),
    });
    try {
      const dc = pc.createDataChannel(CHANNEL_LABEL);
      const opened = new Promise<void>((resolve, reject) => {
        dc.onOpen(() => resolve());
        dc.onError((e) => reject(new Error(`direct channel error: ${e}`)));
        pc.onStateChange((s) => { if (s === "failed") reject(new Error("direct punch failed")); });
      });
      await waitGathered(pc, GATHER_TIMEOUT_MS);
      const offer = pc.localDescription();
      if (!offer || offer.type !== "offer") throw new Error("no local offer");
      const answer = await opts.signal(offer.sdp);
      pc.setRemoteDescription(answer, "answer");
      const timeoutMs = opts.timeoutMs ?? OPEN_TIMEOUT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        opened,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`direct channel did not open within ${timeoutMs} ms`)), timeoutMs); }),
      ]).finally(() => clearTimeout(timer));
      return new DirectTunnel(pc, dc, opts.log ?? (() => {}));
    } catch (e) {
      try { pc.close(); } catch { /* closed */ }
      throw e;
    }
  }

  get open(): boolean { return !this.#closed && this.#dc.isOpen(); }

  /** Which candidates won: "host" (same network), "srflx" (punched through
   *  NAT with the relay's STUN), "prflx" (learned during the punch itself). */
  selectedPair(): { local: CandidateEnd; remote: CandidateEnd } | null {
    const p = this.#pc.getSelectedCandidatePair();
    if (!p) return null;
    const end = (c: { type: string; address: string; port: number }) => ({ type: c.type, address: c.address, port: c.port });
    return { local: end(p.local), remote: end(p.remote) };
  }

  exchange(wire: Uint8Array): ReadableStream<Uint8Array> {
    if (!this.open) throw new Error("direct channel closed");
    const id = this.#nextId++;
    const self = this;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        self.#pending.set(id, controller);
        void (async () => {
          for (const frame of framesFor(KIND_REQUEST, id, wire, true)) await self.#writer.send(frame);
        })().catch((e) => { if (self.#pending.delete(id)) controller.error(e); });
      },
      cancel() {
        if (!self.#pending.delete(id)) return;
        if (self.#dc.isOpen()) self.#dc.sendMessageBinary(encodeFrame(KIND_CANCEL, id, true));
      },
    });
  }

  #teardown(err: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#writer.wakeAll();
    for (const c of this.#pending.values()) c.error(err);
    this.#pending.clear();
  }

  close(): void {
    this.#teardown(new Error("direct channel closed"));
    try { this.#dc.close(); } catch { /* closed */ }
    try { this.#pc.close(); } catch { /* closed */ }
  }
}
