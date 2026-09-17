// The Joy Browser extension against a REAL relay: real HTTP, real PGlite, the
// extension's own relay client, crypto and watcher — only chrome.* is faked.
//
// What this proves that the extension's unit tests cannot: that a session row
// as the relay serves it opens with the account's content key, that the
// agent's sealed output is found on /events under the field names the client
// expects, and that the answer travels the durable queue and reaches the
// daemon as an ordinary prompt wrapped <joy-message from="browser">.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { startRelay } from './harness.mjs';
import * as N from '../../joy-mcp/src/crypto.mjs'; // the daemon's side of each format

globalThis.self = globalThis; // the vendored tweetnacl attaches to `self`, as in a service worker
const B = await import('../../joy-browser/src/crypto.js');
const { RelayClient } = await import('../../joy-browser/src/relay.js');
const { Watcher } = await import('../../joy-browser/src/watcher.js');

let relay;
beforeAll(async () => { relay = await startRelay(); });
afterAll(async () => { await relay.close(); });

describe('joy-browser end to end', () => {
  it('a tag the agent emits is run once and answered through the queue', async () => {
    const accountSecret = new Uint8Array(randomBytes(32));
    const sessionKey = new Uint8Array(randomBytes(32));

    // ── the daemon announces a session whose key is enveloped to the account ──
    const d = relay.makeDaemon('mach-browser');
    await d.acquire();
    const envelope = N.sealSessionKeyEnvelope(sessionKey, N.contentKeyPair(accountSecret).publicKey);
    const created = await relay.call('POST', '/joy/v2/sessions', { body: { mode: 'announce_existing', creationIntentId: randomUUID(), daemonId: d.daemonId, localSessionId: 'abcd1234', sessionKeyEnvelope: envelope } });
    expect(created.status).toBe(200);
    const sessionId = created.json.sessionId;
    await d.card(sessionId, { encryptedMetadata: N.sealCard({ path: '/work/site', host: 'metal', summary: { text: 'Scrape the pricing page' }, joy__headless: true }, sessionKey) });

    // ── the extension, paired: it finds the session and opens its card ──
    const client = new RelayClient({ relayUrl: relay.base, token: 'app-token' });
    const contentSecret = B.contentKeyPair(accountSecret).secretKey;
    const row = (await client.listSessions()).sessions.find((s) => s.sessionId === sessionId);
    const key = B.openSessionKeyEnvelope(row.sessionKeyEnvelope, contentSecret);
    expect([...key]).toEqual([...sessionKey]);
    expect(B.openCard(row.encryptedMetadata, key)).toMatchObject({ summary: { text: 'Scrape the pricing page' }, joy__headless: true });

    // ── a turn is already under way when the browser attaches ──
    const first = await relay.post(sessionId, { ciphertext: N.sealText('find the price on the pricing page', sessionKey) });
    const offer = relay.offerFor(await d.claim('work'), sessionId);
    await d.received(offer.deliveryId); await d.submitted(first.json.turnId);
    await d.start(first.json.turnId, { runtimeEventId: randomUUID() });
    const record = (text, extra = {}) => N.sealV2Json({ v: 1, t: 'record', record: { role: 'agent', content: { type: 'event', data: { ev: { t: 'text', text, ...extra }, turn: first.json.turnId } } } }, sessionKey);
    const emit = (text, extra) => d.fact(first.json.turnId, { type: 'output', ciphertext: record(text, extra), runtimeEventId: randomUUID() });
    expect((await emit('<joy-browser-execute>\nreturn "said BEFORE the browser attached";\n</joy-browser-execute>')).status).toBe(200);

    // attach = start at the head: history is not news
    const head = Number((await client.listSessions()).sessions.find((s) => s.sessionId === sessionId).headSeq);
    const state = { sessionId, key, cursor: head };
    const ran = [];
    const watcher = new Watcher({
      relay: client,
      store: { load: async () => ({ ...state }), saveCursor: async (n) => { state.cursor = n; } },
      execute: async (tag) => { ran.push(tag); return { tab: { id: 7, url: tag.attrs.url ?? 'https://shop.test/pricing', title: 'Pricing' }, value: '"$49 / month"', console: ['log: found 1 price'] }; },
    });
    await watcher.poll();
    expect(ran).toEqual([]);

    // ── the agent thinks about the tag (must not run), then really emits it ──
    await emit('<joy-browser-execute>return "only thinking"</joy-browser-execute>', { thinking: true });
    await emit('Reading the page.\n\n<joy-browser-execute url="https://shop.test/pricing?a>b">\nreturn document.querySelector(".price").textContent;\n</joy-browser-execute>');
    await d.fact(first.json.turnId, { type: 'terminal', terminalState: 'completed', runtimeEventId: randomUUID() });

    await watcher.poll();
    expect(ran).toHaveLength(1);
    expect(ran[0]).toEqual({ attrs: { url: 'https://shop.test/pricing?a>b' }, code: 'return document.querySelector(".price").textContent;' });

    // ── the answer is an ordinary queued prompt the daemon now claims ──
    const answerOffer = relay.offerFor(await d.claim('work'), sessionId);
    expect(answerOffer).toBeTruthy();
    const prompt = N.openPayload(answerOffer.ciphertext ?? answerOffer.content?.ciphertext, sessionKey);
    expect(prompt.t).toBe('plain');
    expect(prompt.text).toBe([
      '<joy-message from="browser">',
      'tab 7 · https://shop.test/pricing?a>b · "Pricing"',
      'status: ok',
      'value: "$49 / month"',
      'console:',
      '  log: found 1 price',
      '</joy-message>',
    ].join('\n'));

    // ── and it never runs twice: not on a re-poll, not from its own echo ──
    await watcher.poll();
    await watcher.poll();
    expect(ran).toHaveLength(1);
    const queued = await relay.call('GET', `/joy/v2/sessions/${sessionId}/messages?limit=50`);
    expect(queued.json.messages.filter((m) => m.turnId !== first.json.turnId)).toHaveLength(1);
  }, 30_000);
});
