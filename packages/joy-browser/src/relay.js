// The relay's account-side v2 API — the subset an attached browser needs.
// A port of packages/joy-mcp/src/relay.mjs: same routes, same renewal on 401
// (nobody is here to tap "sign in again"), fetch instead of node:crypto.
import { b64, signKeyPair, sign, randomBytes } from './crypto.js';

const CLIENT = 'joy-browser';

export class RelayError extends Error {
  constructor(status, code) { super(`relay ${status}: ${code}`); this.status = status; this.code = code; }
}

/** POST /auth — a signature over a self-chosen challenge. Returns the bearer. */
export async function loginWithSecret(relayUrl, accountSecret, { perimeterKey } = {}) {
  const kp = signKeyPair(accountSecret);
  const challenge = randomBytes(32);
  const headers = { 'content-type': 'application/json', 'x-joy-client': CLIENT };
  if (perimeterKey) headers['x-joy-relay-key'] = perimeterKey;
  const r = await fetch(`${relayUrl}/joy/v2/auth`, {
    method: 'POST', headers,
    body: JSON.stringify({ publicKey: b64(kp.publicKey), challenge: b64(challenge), signature: b64(sign(challenge, kp.secretKey)) }),
  });
  const json = await r.json().catch(() => null);
  if (!r.ok || !json?.token) throw new RelayError(r.status, json?.error ?? 'login_failed');
  return String(json.token);
}

export class RelayClient {
  constructor({ relayUrl, token, perimeterKey = null, renew = null }) {
    this.relayUrl = relayUrl.replace(/\/+$/, '');
    this.token = token; this.perimeterKey = perimeterKey; this.renew = renew;
  }
  headers(extra = {}) {
    const h = { authorization: `Bearer ${this.token}`, 'x-joy-client': CLIENT, ...extra };
    if (this.perimeterKey) h['x-joy-relay-key'] = this.perimeterKey;
    return h;
  }
  async call(method, path, body, retryAuth = true) {
    const res = await fetch(`${this.relayUrl}/joy/v2${path}`, {
      method,
      headers: this.headers(body !== undefined ? { 'content-type': 'application/json' } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && retryAuth && this.renew) {
      this.token = await this.renew();
      return this.call(method, path, body, false);
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-json */ }
    if (!res.ok) throw new RelayError(res.status, json?.error ?? `http_${res.status}`);
    return json;
  }
  listSessions() { return this.call('GET', '/sessions'); }
  sessionState(id) { return this.call('GET', `/sessions/${encodeURIComponent(id)}`); }
  events(id, after, limit = 200) { return this.call('GET', `/sessions/${encodeURIComponent(id)}/events?after=${after}&limit=${limit}`); }
  /** The durable queue: a sealed prompt in, { messageId, turnId, seq } out. */
  sendCiphertext(sessionId, ciphertext) {
    return this.call('POST', `/sessions/${encodeURIComponent(sessionId)}/messages`, { ciphertext, clientIntentId: crypto.randomUUID() });
  }

  /** The doorbell: a long-lived SSE stream. `onPoke(sessionId)` says "something
   *  changed, re-read"; nothing is carried in it. Reconnects until stopped. */
  stream({ onPoke, onError }) {
    let stopped = false; let ctrl = null;
    const run = async () => {
      let backoff = 1000;
      while (!stopped) {
        ctrl = new AbortController();
        try {
          const res = await fetch(`${this.relayUrl}/joy/v2/events/stream`, { headers: this.headers(), signal: ctrl.signal });
          if (res.status === 401 && this.renew) { this.token = await this.renew(); continue; }
          if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
          backoff = 1000;
          const reader = res.body.getReader(); const decoder = new TextDecoder(); let buf = '';
          while (!stopped) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf('\n\n')) >= 0) {
              const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
              const data = frame.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart());
              if (!data.length) continue;
              let d; try { d = JSON.parse(data.join('\n')); } catch { continue; }
              if (d?.sessionId ?? d?.id) onPoke?.(d.sessionId ?? d.id);
            }
          }
        } catch (e) { if (!stopped) onError?.(e); }
        if (stopped) break;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 15_000);
      }
    };
    void run();
    return () => { stopped = true; ctrl?.abort(); };
  }
}
