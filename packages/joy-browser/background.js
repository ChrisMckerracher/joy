// Joy Browser — the service worker.
//
// A client of ONE joy account, paired from its backup code like the MCP
// server. It watches one attached session over the relay; when the agent
// emits <joy-browser-execute>, it runs the script in a tab and queues the
// outcome back into the session as <joy-message from="browser">.
//
// Scripts run through chrome.debugger (Runtime.evaluate), not
// chrome.scripting: Manifest V3 will not evaluate a string, and an agent's
// script is a string. The cost is Chrome's "is debugging this browser" bar
// while a script runs; the debugger is attached per run and detached after.
import { parseBackupCode, contentKeyPair, relayPerimeterKey, openSessionKeyEnvelope, openCard, sealText, b64, unb64 } from './src/crypto.js';
import { loginWithSecret, RelayClient } from './src/relay.js';
import { Watcher } from './src/watcher.js';
import { browserMessage } from './src/tags.js';

const ALARM = 'joy-browser-poll';
const RUN_TIMEOUT_MS = 60_000;
const LOAD_TIMEOUT_MS = 30_000;

// ── state ────────────────────────────────────────────────────────────────────
// chrome.storage.local: { relayUrl, secret (b64), attached: { sessionId,
// localId, title, envelope }, cursor, log: [] }. The worker is killed and
// restarted at will, so nothing that matters lives only in memory.
const get = (keys) => chrome.storage.local.get(keys);
const set = (obj) => chrome.storage.local.set(obj);

async function log(line) {
  const { log: lines = [] } = await get('log');
  lines.push(`${new Date().toLocaleTimeString()}  ${line}`);
  await set({ log: lines.slice(-60) });
}

let client = null; // { relay, contentSecret } — rebuilt from storage on demand
async function ensureClient() {
  if (client) return client;
  const { relayUrl, secret } = await get(['relayUrl', 'secret']);
  if (!relayUrl || !secret) return null;
  const accountSecret = unb64(secret);
  const perimeterKey = relayPerimeterKey(accountSecret);
  const renew = () => loginWithSecret(relayUrl, accountSecret, { perimeterKey });
  const relay = new RelayClient({ relayUrl, token: await renew(), perimeterKey, renew });
  client = { relay, contentSecret: contentKeyPair(accountSecret).secretKey };
  return client;
}

// ── running a script ─────────────────────────────────────────────────────────
const tabInfo = (t) => ({ id: t.id, url: t.url, title: t.title });
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms))]);

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.filter((t) => t.url).slice(0, 40).map((t) => ({ ...tabInfo(t), active: t.active }));
}

async function activeTab() {
  let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !/^https?:|^file:/.test(tab.url ?? '')) {
    // The last focused window can be DevTools or an extension page.
    const candidates = await chrome.tabs.query({ active: true, windowType: 'normal' });
    tab = candidates.find((t) => /^https?:|^file:/.test(t.url ?? '')) ?? tab;
  }
  return tab ?? null;
}

function waitForLoad(tabId) {
  return withTimeout(new Promise((resolve) => {
    const done = (id, info) => { if (id === tabId && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(done); resolve(); } };
    chrome.tabs.onUpdated.addListener(done);
    chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete') { chrome.tabs.onUpdated.removeListener(done); resolve(); } }).catch(() => {});
  }), LOAD_TIMEOUT_MS, 'page load');
}

const remoteText = (a) => (a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : a.description ?? a.type);

async function runInTab(tab, code) {
  const target = { tabId: tab.id };
  const lines = [];
  const onEvent = (src, method, params) => {
    if (src.tabId === tab.id && method === 'Runtime.consoleAPICalled') lines.push(`${params.type}: ${params.args.map(remoteText).join(' ')}`);
  };
  try { await chrome.debugger.attach(target, '1.3'); }
  catch (e) { return { tab: tabInfo(tab), error: `cannot attach to this tab (${e.message}). Browser-internal pages (chrome://, the Web Store) and tabs another debugger holds cannot be scripted.` }; }
  chrome.debugger.onEvent.addListener(onEvent);
  try {
    await chrome.debugger.sendCommand(target, 'Runtime.enable');
    // An async function body: `await` works and `return` is the answer.
    const r = await withTimeout(chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: `(async () => {\n${code}\n})()`, awaitPromise: true, returnByValue: true, userGesture: true,
    }), RUN_TIMEOUT_MS, 'the script');
    const now = await chrome.tabs.get(tab.id).catch(() => tab);
    if (r.exceptionDetails) {
      const ex = r.exceptionDetails;
      return { tab: tabInfo(now), error: ex.exception?.description ?? ex.text ?? 'script threw', console: lines };
    }
    const value = r.result?.type === 'undefined' ? undefined : typeof r.result?.value === 'string' ? r.result.value : JSON.stringify(r.result?.value ?? null, null, 2);
    return { tab: tabInfo(now), value, console: lines };
  } catch (e) {
    const now = await chrome.tabs.get(tab.id).catch(() => tab);
    // A script that navigates dies with its page; that is an outcome, not a fault.
    const navigated = /navigated|context was destroyed|Target closed|Cannot find context/i.test(e.message ?? '');
    return { tab: tabInfo(now), error: navigated ? `the page unloaded while the script ran (now at ${now.url}). Run another script to read the new page.` : e.message ?? String(e), console: lines };
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
    await chrome.debugger.detach(target).catch(() => {});
  }
}

async function execute(tag) {
  if (tag.attrs.tab === 'list') return { tab: null, value: 'the open tabs follow', tabs: await listTabs() };
  let tab;
  if (tag.attrs.url) {
    if (!/^https?:\/\//i.test(tag.attrs.url)) return { tab: null, error: `url must be http(s): ${tag.attrs.url}` };
    tab = await chrome.tabs.create({ url: tag.attrs.url, active: true });
    try { await waitForLoad(tab.id); } catch (e) { return { tab: tabInfo(tab), error: e.message }; }
    tab = await chrome.tabs.get(tab.id);
  } else if (tag.attrs.tab && /^\d+$/.test(tag.attrs.tab)) {
    tab = await chrome.tabs.get(Number(tag.attrs.tab)).catch(() => null);
    if (!tab) return { tab: null, error: `no tab ${tag.attrs.tab} — run tab="list" to see the open tabs` };
  } else {
    tab = await activeTab();
    if (!tab) return { tab: null, error: 'no active tab to run in' };
  }
  if (!tag.code.trim()) return { tab: tabInfo(tab), value: tag.attrs.url ? 'opened and loaded' : 'nothing to run (empty script)' };
  return runInTab(tab, tag.code);
}

// ── watching ─────────────────────────────────────────────────────────────────
const store = {
  async load() {
    const { attached, cursor } = await get(['attached', 'cursor']);
    const c = attached ? await ensureClient() : null;
    if (!attached || !c) return null;
    return { sessionId: attached.sessionId, cursor, key: attached.envelope ? openSessionKeyEnvelope(attached.envelope, c.contentSecret) : null };
  },
  saveCursor: (cursor) => set({ cursor }),
};

let watcher = null; let stopStream = null;
async function ensureWatching() {
  const { attached } = await get('attached');
  const c = attached ? await ensureClient().catch(async (e) => { await log(`cannot reach the relay: ${e.message}`); return null; }) : null;
  if (!attached || !c) { stopStream?.(); stopStream = null; watcher = null; return; }
  if (!watcher) watcher = new Watcher({ relay: c.relay, store, execute, log });
  if (!stopStream) {
    stopStream = c.relay.stream({
      onPoke: (sessionId) => { if (sessionId === attached.sessionId) void watcher?.poll().catch((e) => log(`poll failed: ${e.message}`)); },
      onError: () => { /* the stream reconnects itself; the alarm is the floor */ },
    });
  }
  await watcher.poll().catch((e) => log(`poll failed: ${e.message}`));
}

// The worker sleeps after ~30s idle and the stream dies with it. The alarm is
// the floor: at worst a tag waits one period; with the popup or a busy stream
// keeping the worker up, it runs at once.
chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) void ensureWatching(); });
chrome.runtime.onStartup.addListener(() => void ensureWatching());
chrome.runtime.onInstalled.addListener(() => void ensureWatching());
void ensureWatching();

// ── the popup's requests ─────────────────────────────────────────────────────
async function sessionsView() {
  const c = await ensureClient();
  if (!c) return [];
  const { sessions = [] } = await c.relay.listSessions();
  return sessions
    .filter((s) => s.state !== 'archived' && s.state !== 'deleted')
    .map((s) => {
      const key = openSessionKeyEnvelope(s.sessionKeyEnvelope, c.contentSecret);
      const meta = s.encryptedMetadata ? openCard(s.encryptedMetadata, key) : null;
      return {
        sessionId: s.sessionId, localId: s.localSessionId ?? s.sessionId.slice(0, 8), envelope: s.sessionKeyEnvelope ?? null, headSeq: Number(s.headSeq) || 0,
        title: meta?.summary?.text ?? null, cwd: meta?.path ?? null, host: meta?.host ?? null, harness: meta?.flavor ?? 'claude',
        headless: meta?.joy__headless === true, online: !!s.online, readable: key !== null || !s.encryptedMetadata,
        at: s.lastTurnAt ?? s.updatedAt ?? s.createdAt ?? 0,
      };
    })
    .sort((a, b) => Number(b.online) - Number(a.online) || b.at - a.at);
}

const handlers = {
  async status() {
    const { relayUrl, secret, attached, log: lines = [] } = await get(['relayUrl', 'secret', 'attached', 'log']);
    return { paired: !!(relayUrl && secret), relayUrl: relayUrl ?? null, attached: attached ?? null, log: lines };
  },
  async pair({ relayUrl, backupCode }) {
    const url = (/^https?:\/\//i.test(relayUrl.trim()) ? relayUrl.trim() : `https://${relayUrl.trim()}`).replace(/\/+$/, '');
    const accountSecret = parseBackupCode(backupCode);
    await loginWithSecret(url, accountSecret, { perimeterKey: relayPerimeterKey(accountSecret) }); // proves relay + code before anything is kept
    client = null;
    await set({ relayUrl: url, secret: b64(accountSecret), attached: null, cursor: 0 });
    await log(`paired with ${url}`);
    return { ok: true };
  },
  async unpair() {
    stopStream?.(); stopStream = null; watcher = null; client = null;
    await chrome.storage.local.clear();
    return { ok: true };
  },
  sessions: async () => ({ sessions: await sessionsView() }),
  async attach({ session, announce }) {
    // History is not news: start at the head, so only tags emitted from now on run.
    await set({ attached: { sessionId: session.sessionId, localId: session.localId, title: session.title, envelope: session.envelope }, cursor: session.headSeq });
    stopStream?.(); stopStream = null; watcher = null;
    await log(`attached to ${session.localId}${session.title ? ` — ${session.title}` : ''}`);
    if (announce) {
      const c = await ensureClient();
      const key = session.envelope ? openSessionKeyEnvelope(session.envelope, c.contentSecret) : null;
      const tab = await activeTab();
      const hello = `A browser is now attached to this session: you can run JavaScript in it with <joy-browser-execute>, as your instructions describe. ${tab ? `The active tab is ${tab.id} · ${tab.url} · "${tab.title}".` : 'No page is open yet — open one with the url attribute.'} Nothing is being asked of you by this message.`;
      await c.relay.sendCiphertext(session.sessionId, sealText(browserMessage(hello), key));
    }
    await ensureWatching();
    return { ok: true };
  },
  async detach() {
    const { attached } = await get('attached');
    stopStream?.(); stopStream = null; watcher = null;
    await set({ attached: null, cursor: 0 });
    if (attached) await log(`detached from ${attached.localId}`);
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  const h = handlers[msg?.type];
  if (!h) return false;
  h(msg).then(respond, (e) => respond({ error: e?.message ?? String(e) }));
  return true; // the answer is asynchronous
});
