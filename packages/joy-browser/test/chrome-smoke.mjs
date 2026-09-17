#!/usr/bin/env node
// A REAL-BROWSER smoke test — not part of `pnpm test`, because it needs a
// Chromium binary and starts a relay. Run it by hand:
//
//   node test/chrome-smoke.mjs [/path/to/chrome]
//
// It starts the real relay (real accounts, real tokens, PGlite in a temp dir),
// plays the daemon's part by hand, loads this directory as an unpacked
// extension in headless Chromium, and then does what a person would: opens the
// popup, pairs with a backup code, attaches to the session. The "agent" then
// emits <joy-browser-execute> and the script must run in a real page through
// chrome.debugger, with the answer coming back through the relay's queue.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import * as N from '../../joy-mcp/src/crypto.mjs';
import { loginWithSecret } from '../../joy-mcp/src/relay.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const EXT = join(here, '..');
const CHROME = process.argv[2] ?? [join(homedir(), '.cache/ms-playwright/chromium-1208/chrome-linux64/chrome'), '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
if (!CHROME) { console.error('no Chromium found — pass its path as the first argument'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, fn, ms = 30_000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(150); } };
const step = (s) => console.log(`  · ${s}`);
const cleanup = [];

async function main() {
  // ── a page worth scripting ──
  const site = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Pricing</title><h1>Plans</h1><p class="price">$49 / month</p><script>console.log("page ready")</script>'); });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  cleanup.push(() => site.close());
  const pageUrl = `http://127.0.0.1:${site.address().port}/pricing`;

  // ── the real relay ──
  const dataDir = mkdtempSync(join(tmpdir(), 'joy-browser-smoke-relay-'));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const relayProc = spawn(process.execPath, [join(here, '../../joy-relay/server.mjs')], { env: { ...process.env, JOY_RELAY_PORT: String(port), JOY_RELAY_DATA_DIR: dataDir, JOY_RELAY_DOCS: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
  cleanup.push(() => relayProc.kill('SIGTERM'));
  let relayLog = ''; relayProc.stdout.on('data', (d) => (relayLog += d)); relayProc.stderr.on('data', (d) => (relayLog += d));
  const relayUrl = `http://127.0.0.1:${port}`;
  await until('the relay to listen', async () => fetch(`${relayUrl}/joy/v2/capabilities`).then((r) => r.ok, () => false)).catch((e) => { throw new Error(`${e.message}\n${relayLog}`); });
  step(`relay up at ${relayUrl}`);

  // ── an account, and the daemon's half of one session ──
  const accountSecret = new Uint8Array(randomBytes(32));
  const backupCode = Buffer.from(accountSecret).toString('base64url');
  const { token } = await loginWithSecret(relayUrl, accountSecret);
  const api = async (method, path, body, headers = {}) => {
    const r = await fetch(`${relayUrl}/joy/v2${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j)}`);
    return j;
  };
  const lease = await api('POST', '/daemon/leases', { machineId: 'smoke-machine' });
  const L = { 'x-joy-lease-id': lease.leaseId, 'x-joy-lease-token': lease.leaseToken, 'x-joy-lease-epoch': String(lease.epoch) };
  const renew = setInterval(() => void api('PUT', `/daemon/leases/${lease.leaseId}`, {}, L).catch(() => {}), 5_000);
  cleanup.push(() => clearInterval(renew));
  const sessionKey = new Uint8Array(randomBytes(32));
  const { sessionId } = await api('POST', '/sessions', { mode: 'announce_existing', creationIntentId: randomUUID(), daemonId: 'smoke-machine', localSessionId: 'c0ffee42', sessionKeyEnvelope: N.sealSessionKeyEnvelope(sessionKey, N.contentKeyPair(accountSecret).publicKey) });
  await api('PATCH', `/daemon/sessions/${sessionId}`, { encryptedMetadata: N.sealCard({ path: '/work/site', host: 'smoke', summary: { text: 'Smoke test session' }, joy__headless: true }, sessionKey) }, L);
  const claim = async () => (await api('POST', `/daemon/leases/${lease.leaseId}/claims/work`, { noWait: true }, L)).offers ?? [];
  const takePrompt = async (what) => {
    const offer = await until(what, async () => (await claim()).find((o) => o.sessionId === sessionId && o.kind === 'prompt'));
    await api('POST', `/daemon/deliveries/${offer.deliveryId}/received`, undefined, L);
    await api('POST', `/daemon/turns/${offer.turnId}/submitted`, undefined, L);
    await api('POST', `/daemon/turns/${offer.turnId}/start`, { runtimeEventId: randomUUID() }, L);
    return { turnId: offer.turnId, text: N.openPayload(offer.ciphertext ?? offer.content?.ciphertext, sessionKey)?.text };
  };
  const say = (turnId, text) => api('POST', `/daemon/turns/${turnId}/facts`, { type: 'output', runtimeEventId: randomUUID(), ciphertext: N.sealV2Json({ v: 1, t: 'record', record: { role: 'agent', content: { type: 'event', data: { ev: { t: 'text', text }, turn: turnId } } } }, sessionKey) }, L);
  const endTurn = (turnId) => api('POST', `/daemon/turns/${turnId}/facts`, { type: 'terminal', terminalState: 'completed', runtimeEventId: randomUUID() }, L);
  step(`session c0ffee42 announced (${sessionId.slice(0, 8)})`);

  // ── Chromium, with this directory loaded unpacked ──
  const profile = mkdtempSync(join(tmpdir(), 'joy-browser-smoke-chrome-'));
  cleanup.push(() => rmSync(profile, { recursive: true, force: true }));
  const env = { ...process.env }; delete env.DISPLAY;
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, 'about:blank'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  cleanup.push(() => chrome.kill('SIGKILL'));
  let chromeErr = ''; chrome.stderr.on('data', (d) => (chromeErr += d));
  const wsUrl = await until('Chromium DevTools', () => /DevTools listening on (ws:\/\/\S+)/.exec(chromeErr)?.[1]);
  const http = wsUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/.*$/, '');
  const targets = () => fetch(`${http}/json/list`).then((r) => r.json());
  const worker = await until('the extension service worker', async () => (await targets()).find((t) => t.type === 'service_worker' && t.url.endsWith('/background.js'))).catch((e) => { throw new Error(`${e.message}\n${chromeErr.slice(-1500)}`); });
  const extId = new URL(worker.url).host;
  step(`extension loaded (${extId}), service worker running`);

  // Drive the popup as a page, the way a person's clicks would.
  const popupTarget = await fetch(`${http}/json/new?chrome-extension://${extId}/popup.html`, { method: 'PUT' }).then((r) => r.json());
  const ws = new WebSocket(popupTarget.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cannot reach the popup over CDP')); });
  cleanup.push(() => ws.close());
  let nextId = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const evalInPopup = async (expression) => {
    const id = ++nextId;
    const reply = await new Promise((res) => { pending.set(id, res); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); });
    if (reply.result?.exceptionDetails) throw new Error(`popup: ${reply.result.exceptionDetails.exception?.description ?? reply.result.exceptionDetails.text}`);
    return reply.result?.result?.value;
  };
  await until('the pairing form', () => evalInPopup(`!!document.querySelector('input[type=password]')`));
  await evalInPopup(`(() => { const [relay, code] = document.querySelectorAll('input'); relay.value = ${JSON.stringify(relayUrl)}; code.value = ${JSON.stringify(backupCode)}; document.querySelector('button').click(); })()`);
  await until('the session list', () => evalInPopup(`[...document.querySelectorAll('li .t')].some((n) => n.textContent.includes('Smoke test session'))`)).catch(async (e) => { throw new Error(`${e.message} — popup shows: ${await evalInPopup('document.body.innerText')}`); });
  step('paired from the backup code; the session is listed, card opened');
  await evalInPopup(`[...document.querySelectorAll('li')].find((n) => n.textContent.includes('Smoke test session')).click()`);
  await until('the attached view', () => evalInPopup(`document.body.innerText.includes('Attached')`));
  step('attached');

  // ── the hello arrives as a prompt; the agent answers it with a script ──
  const hello = await takePrompt('the browser hello');
  if (!/^<joy-message from="browser">\nA browser is now attached/.test(hello.text ?? '')) throw new Error(`unexpected hello: ${hello.text}`);
  step('hello received as <joy-message from="browser">');
  await say(hello.turnId, `Reading the pricing page.\n\n<joy-browser-execute url="${pageUrl}">\nconsole.log("counting", document.querySelectorAll("p").length);\nawait new Promise((r) => setTimeout(r, 50));\nreturn { title: document.title, price: document.querySelector(".price").textContent, cheap: 1 < 2 && 3 > 2 };\n</joy-browser-execute>`);
  await endTurn(hello.turnId);

  // ── the script ran in a real page, and its outcome is the next prompt ──
  const answer = await takePrompt('the script result');
  console.log('\n' + answer.text.split('\n').map((l) => `    ${l}`).join('\n') + '\n');
  const must = [/^<joy-message from="browser">/, /status: ok/, /"title": "Pricing"/, /"price": "\$49 \/ month"/, /"cheap": true/, /log: counting 1/, new RegExp(pageUrl.replace(/[/.]/g, '\\$&')), /<\/joy-message>$/];
  for (const re of must) if (!re.test(answer.text)) throw new Error(`the result is missing ${re}`);

  // ── an error is an answer too ──
  await say(answer.turnId, '<joy-browser-execute>\nreturn nope.nothing;\n</joy-browser-execute>');
  await endTurn(answer.turnId);
  const failure = await takePrompt('the error result');
  if (!/status: error\nerror: ReferenceError: nope is not defined/.test(failure.text)) throw new Error(`expected a ReferenceError, got:\n${failure.text}`);
  step('a throwing script comes back as status: error, with the exception');
  await endTurn(failure.turnId);
}

let code = 0;
try { console.log('joy-browser smoke test'); await main(); console.log('PASS'); }
catch (e) { console.error(`\nFAIL: ${e.stack ?? e}`); code = 1; }
finally { for (const c of cleanup.reverse()) { try { await c(); } catch { /* best effort */ } } }
process.exit(code);
