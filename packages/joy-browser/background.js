// Joy Browser — the background half (a service worker in Chrome, a background
// page in Firefox; the same code).
//
// A client of ONE joy account, paired from its backup code like the MCP
// server, talking only to the relay. v1 ties ONE session to the browser: on
// setup it starts a headless session on the machine you chose, links to it and
// remembers it. From then on it
//   · runs what that session's agent emits as <joy-browser-execute>,
//   · saves what it emits as <joy-browser-remember> — which stays OFF until
//     you approve it — and runs approved scripts on every matching page load,
//   · feeds the chat panel the page button opens (content.js),
// all of it subject to two brakes the agent cannot reach: the pause switch and
// the excluded-sites list.
import { api } from './src/api.js';
import { parseBackupCode, contentKeyPair, relayPerimeterKey, openSessionKeyEnvelope, openCard, openMachineKey, openMachineMetadata, sealSpawnSpec, sealText, b64, unb64 } from './src/crypto.js';
import { loginWithSecret, RelayClient, relayAddress, describeRelay } from './src/relay.js';
import { Watcher } from './src/watcher.js';
import { browserMessage, splitMatch } from './src/tags.js';
import { matchesAny, normalizePattern } from './src/patterns.js';
import { foldEvents } from './src/conversation.js';
import { runInTab, tabInfo, withTimeout } from './src/runner.js';

const ALARM = 'joy-browser-poll';
const LOAD_TIMEOUT_MS = 30_000;
const DEFAULT_FOLDER = '~/joy-browser';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── state ────────────────────────────────────────────────────────────────────
// storage.local — the background can be stopped at any moment, so nothing that
// matters lives only in memory:
//   setup    { relayUrl, secret (b64), machineId, machineName, cwd }
//   linked   { sessionId, localId, title, envelope } | null     cursor  number
//   paused   boolean          excluded [pattern]          fab { x, y }
//   scripts  [{ id, name, match[], code, enabled, approved, createdAt }]
//   linkError string | null   log [line]
const get = (keys) => api.storage.local.get(keys);
const set = (obj) => api.storage.local.set(obj);

async function log(line) {
  const { log: lines = [] } = await get('log');
  lines.push(`${new Date().toLocaleTimeString()}  ${line}`);
  await set({ log: lines.slice(-80) });
}

let client = null; // { relay, contentSecret } — rebuilt from storage on demand
async function ensureClient() {
  if (client) return client;
  const { setup } = await get('setup');
  if (!setup?.relayUrl || !setup?.secret) return null;
  const accountSecret = unb64(setup.secret);
  const perimeterKey = relayPerimeterKey(accountSecret);
  const renew = () => loginWithSecret(setup.relayUrl, accountSecret, { perimeterKey });
  client = { relay: new RelayClient({ relayUrl: setup.relayUrl, token: await renew(), perimeterKey, renew }), contentSecret: contentKeyPair(accountSecret).secretKey };
  return client;
}
const keyOf = (linked, c) => (linked?.envelope ? openSessionKeyEnvelope(linked.envelope, c.contentSecret) : null);

// ── the two brakes ───────────────────────────────────────────────────────────
const brakes = async () => { const { paused = false, excluded = [] } = await get(['paused', 'excluded']); return { paused, excluded }; };
const PAUSED = 'the user has paused browser control in the Joy Browser extension. Nothing ran. Tell them, and wait until they resume it.';
const excludedError = (url) => `${url} is on the user's excluded-sites list, so the extension will not run scripts there or report on it. Do not try to work around this; tell the user if the task needs that site.`;

// ── running scripts ──────────────────────────────────────────────────────────
// One at a time, agent scripts and saved scripts alike: two debugger sessions
// on one tab refuse each other.
let runQueue = Promise.resolve();
const queued = (fn) => { const p = runQueue.then(fn, fn); runQueue = p.catch(() => {}); return p; };

const scriptable = (url) => /^https?:|^file:/.test(url ?? '');
async function activeTab() {
  let [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !scriptable(tab.url)) {
    // The last focused window can be DevTools or an extension page.
    const candidates = await api.tabs.query({ active: true, windowType: 'normal' });
    tab = candidates.find((t) => scriptable(t.url)) ?? tab;
  }
  return tab ?? null;
}
function waitForLoad(tabId) {
  return withTimeout(new Promise((resolve) => {
    const done = (id, info) => { if (id === tabId && info.status === 'complete') { api.tabs.onUpdated.removeListener(done); resolve(); } };
    api.tabs.onUpdated.addListener(done);
    api.tabs.get(tabId).then((t) => { if (t.status === 'complete') { api.tabs.onUpdated.removeListener(done); resolve(); } }).catch(() => {});
  }), LOAD_TIMEOUT_MS, 'page load');
}

async function execute(tag) {
  const { paused, excluded } = await brakes();
  if (paused) return { tab: null, error: PAUSED };
  if (tag.attrs.tab === 'list') {
    const tabs = (await api.tabs.query({})).filter((t) => t.url && !matchesAny(t.url, excluded));
    return { tab: null, value: 'the open tabs follow (tabs on excluded sites are not listed)', tabs: tabs.slice(0, 40).map((t) => ({ ...tabInfo(t), active: t.active })) };
  }
  let tab;
  if (tag.attrs.url) {
    if (!/^https?:\/\//i.test(tag.attrs.url)) return { tab: null, error: `url must be http(s): ${tag.attrs.url}` };
    if (matchesAny(tag.attrs.url, excluded)) return { tab: null, error: excludedError(tag.attrs.url) };
    tab = await api.tabs.create({ url: tag.attrs.url, active: true });
    try { await waitForLoad(tab.id); } catch (e) { return { tab: tabInfo(tab), error: e.message }; }
    tab = await api.tabs.get(tab.id);
  } else if (tag.attrs.tab && /^\d+$/.test(tag.attrs.tab)) {
    tab = await api.tabs.get(Number(tag.attrs.tab)).catch(() => null);
    if (!tab) return { tab: null, error: `no tab ${tag.attrs.tab} — use tab="list" to see the open tabs` };
  } else {
    tab = await activeTab();
    if (!tab) return { tab: null, error: 'no active tab to run in — open a page with the url attribute' };
  }
  // Checked on the page the script would actually touch — a redirect can land
  // an allowed URL on an excluded site.
  if (matchesAny(tab.url, excluded)) return { tab: null, error: excludedError(new URL(tab.url).host) };
  if (!tag.code.trim()) return { tab: tabInfo(tab), value: tag.attrs.url ? 'opened and loaded' : 'nothing to run (empty script)' };
  return queued(() => runInTab(tab, tag.code));
}

// ── saved scripts ────────────────────────────────────────────────────────────
async function remember(tag) {
  const name = (tag.attrs.name ?? '').trim().slice(0, 80) || 'untitled script';
  const match = [...new Set(splitMatch(tag.attrs.match).map(normalizePattern).filter(Boolean))];
  if (!match.length) return { note: `"${name}" was NOT saved: match must name at least one site, for example match="example.com" or match="example.com/app/*".` };
  if (!tag.code.trim()) return { note: `"${name}" was NOT saved: the script is empty.` };
  const { scripts = [] } = await get('scripts');
  const existing = scripts.find((s) => s.name === name);
  // A changed script goes back to unapproved: approval is of THIS code, on THESE sites.
  const entry = { id: existing?.id ?? crypto.randomUUID(), name, match, code: tag.code, enabled: false, approved: false, createdAt: Date.now() };
  await set({ scripts: [...scripts.filter((s) => s.id !== entry.id), entry] });
  broadcastMeta();
  return { note: `saved "${name}" for ${match.join(', ')}${existing ? ' (replacing the earlier version)' : ''}. It is OFF until the user approves it in the chat panel or under Settings → Saved scripts; you cannot approve it for them. Once on, it runs on every visit to those pages, except excluded sites.` };
}

async function runSavedScripts(tab) {
  if (!scriptable(tab.url) || tab.url.startsWith('file:')) return;
  const { scripts = [] } = await get('scripts');
  const due = scripts.filter((s) => s.enabled && s.approved && matchesAny(tab.url, s.match));
  if (!due.length) return;
  const { paused, excluded } = await brakes();
  if (paused || matchesAny(tab.url, excluded)) return;
  for (const s of due) {
    const r = await queued(() => runInTab(tab, s.code));
    await log(`saved script "${s.name}" on ${new URL(tab.url).host}: ${r.error ? `error — ${String(r.error).split('\n')[0]}` : 'ok'}`);
  }
}
api.tabs.onUpdated.addListener((_id, info, tab) => { if (info.status === 'complete') void runSavedScripts(tab).catch(() => {}); });

// ── the chat feed ────────────────────────────────────────────────────────────
const ports = new Set();
let convo = { sessionId: null, rows: new Map(), working: false, lastSeq: 0, loaded: false };
const convoRows = () => [...convo.rows.values()].sort((a, b) => a.seq - b.seq);
const post = (msg) => { for (const p of ports) { try { p.postMessage(msg); } catch { ports.delete(p); } } };

function absorb(events, key) {
  const fresh = (events ?? []).filter((e) => Number(e.seq) > convo.lastSeq);
  if (!fresh.length) return [];
  const { rows, working } = foldEvents(fresh, key, convo.working);
  convo.working = working;
  convo.lastSeq = Math.max(convo.lastSeq, ...fresh.map((e) => Number(e.seq)));
  for (const r of rows) convo.rows.set(r.seq, r);
  return rows;
}

async function loadConversation() {
  const { linked } = await get('linked');
  const c = linked ? await ensureClient() : null;
  if (!linked || !c) { convo = { sessionId: null, rows: new Map(), working: false, lastSeq: 0, loaded: false }; return; }
  if (convo.sessionId === linked.sessionId && convo.loaded) return;
  convo = { sessionId: linked.sessionId, rows: new Map(), working: false, lastSeq: 0, loaded: false };
  const st = await c.relay.sessionState(linked.sessionId);
  const page = await c.relay.eventsBefore(linked.sessionId, Number(st.headSeq) + 1, 120);
  absorb(page?.messages ?? [], keyOf(linked, c));
  // The relay is the authority on whether a turn is open right now; the fold
  // only knows what the last page of history happened to contain.
  const exec = st.execution?.state ?? st.execution ?? 'idle';
  convo.working = exec !== 'idle';
  convo.loaded = true;
}

async function metaView() {
  const { linked, paused = false, scripts = [], linkError = null, setup } = await get(['linked', 'paused', 'scripts', 'linkError', 'setup']);
  return { session: linked ? { localId: linked.localId, title: linked.title ?? null, machine: setup?.machineName ?? null } : null, paused, linkError, pending: scripts.filter((s) => !s.approved).map(({ id, name, match, code }) => ({ id, name, match, code })) };
}
async function broadcastMeta() { if (ports.size) post({ type: 'meta', ...(await metaView()) }); }

async function sendAsUser(text) {
  const { linked } = await get('linked');
  const c = await ensureClient();
  if (!linked || !c) throw new Error('no session is linked');
  await c.relay.sendCiphertext(linked.sessionId, sealText(text, keyOf(linked, c)));
  void watcher?.poll().catch(() => {});
}

api.runtime.onConnect.addListener((port) => {
  if (port.name !== 'joy-chat') return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener(async (m) => {
    try {
      if (m.type === 'hello') {
        await ensureWatching(); await loadConversation();
        port.postMessage({ type: 'state', rows: convoRows(), working: convo.working, ...(await metaView()) });
      } else if (m.type === 'send') { await sendAsUser(String(m.text)); }
      else if (m.type === 'ping') { void watcher?.poll().catch(() => {}); }
      else if (m.type === 'script') { await handlers['scripts:set']({ id: m.id, approved: m.approve, enabled: m.approve, remove: !m.approve }); }
      else if (m.type === 'pause') { await handlers.pause({ paused: !!m.paused }); }
      else if (m.type === 'hideHere') { await handlers['exclude:add']({ pattern: m.host }); }
    } catch (e) { try { port.postMessage({ type: 'error', message: e?.message ?? String(e) }); } catch { /* gone */ } }
  });
});

// ── watching the linked session ──────────────────────────────────────────────
const store = {
  async load() {
    const { linked, cursor } = await get(['linked', 'cursor']);
    const c = linked ? await ensureClient() : null;
    return linked && c ? { sessionId: linked.sessionId, cursor, key: keyOf(linked, c) } : null;
  },
  saveCursor: (cursor) => set({ cursor }),
};

let watcher = null; let stopStream = null; let watching = null;
function stopWatching() { stopStream?.(); stopStream = null; watcher = null; watching = null; }
async function ensureWatching() {
  const { linked } = await get('linked');
  const c = linked ? await ensureClient().catch(async (e) => { await log(`cannot reach the relay: ${e.message}`); return null; }) : null;
  if (!linked || !c) return stopWatching();
  if (watching !== linked.sessionId) { stopWatching(); watching = linked.sessionId; }
  if (!watcher) {
    watcher = new Watcher({ relay: c.relay, store, execute, remember, log, onEvents: (events, key) => {
      if (convo.sessionId !== linked.sessionId || !convo.loaded) return;
      const rows = absorb(events, key);
      if (rows.length || ports.size) post({ type: 'rows', rows, working: convo.working });
    } });
  }
  if (!stopStream) {
    stopStream = c.relay.stream({
      onPoke: (sessionId) => { if (sessionId === linked.sessionId) void watcher?.poll().catch((e) => log(`poll failed: ${e.message}`)); },
      onError: () => { /* the stream reconnects itself; the alarm is the floor */ },
    });
  }
  await watcher.poll().catch((e) => log(`poll failed: ${e.message}`));
}

// ── the linked session ───────────────────────────────────────────────────────
async function link(row, { announce }) {
  const c = await ensureClient();
  const key = openSessionKeyEnvelope(row.sessionKeyEnvelope, c.contentSecret);
  const meta = row.encryptedMetadata ? openCard(row.encryptedMetadata, key) : null;
  const linked = { sessionId: row.sessionId, localId: row.localSessionId ?? row.sessionId.slice(0, 8), title: meta?.summary?.text ?? null, envelope: row.sessionKeyEnvelope ?? null };
  // History is not news: start at the head, so only what the agent says from now on runs.
  await set({ linked, cursor: Number(row.headSeq) || 0, linkError: null });
  stopWatching(); convo.loaded = false; convo.sessionId = null;
  await log(`linked to session ${linked.localId}${linked.title ? ` — ${linked.title}` : ''}`);
  if (announce) {
    const tab = await activeTab();
    const { excluded = [] } = await get('excluded');
    const here = tab && !matchesAny(tab.url, excluded) ? `The active tab is ${tab.id} · ${tab.url} · "${tab.title}".` : 'Open a page with the url attribute when you need one.';
    await c.relay.sendCiphertext(row.sessionId, sealText(browserMessage(`A browser is now attached to this session: the user's own, through the Joy Browser extension. You can run JavaScript in it with <joy-browser-execute> and offer to save scripts with <joy-browser-remember>, as your instructions describe. ${here} The user talks to you from a chat panel on the pages they browse. Nothing is being asked of you by this message — reply with one short line saying you are ready.`), key));
  }
  await ensureWatching(); await loadConversation(); await broadcastMeta();
  if (ports.size) post({ type: 'state', rows: convoRows(), working: convo.working, ...(await metaView()) });
}

let spawning = null;
function startSession() {
  if (spawning) return spawning;
  spawning = (async () => {
    await set({ linkError: null });
    try {
      const c = await ensureClient();
      const { setup } = await get('setup');
      if (!c || !setup?.machineId) throw new Error('setup is not finished');
      const { machines = [] } = await c.relay.listMachines();
      const m = machines.find((x) => x.id === setup.machineId);
      if (!m) throw new Error('that machine is no longer on this account');
      const machineKey = openMachineKey(m.dataEncryptionKey, c.contentSecret);
      const meta = await openMachineMetadata(m.metadata, machineKey);
      const spec = { cwd: setup.cwd || DEFAULT_FOLDER, agent: 'claude', createDir: true, headless: true };
      const created = await c.relay.createSession(m.id, sealSpawnSpec(spec, meta?.capabilities?.spawnSpecSealed && machineKey ? machineKey : null, m.id));
      const relayId = created.sessionId ?? created.session?.sessionId ?? created.id;
      await log(`asked ${setup.machineName ?? 'the machine'} to start a session in ${spec.cwd}`);
      let row = null; let retried = false;
      for (let i = 0; i < 180; i++) { // a fresh agent can take a while to announce itself
        await sleep(500);
        row = ((await c.relay.listSessions()).sessions ?? []).find((s) => s.sessionId === relayId) ?? null;
        if (row?.state === 'failed') {
          const why = (await c.relay.sessionState(relayId).catch(() => null))?.spawnFailure ?? 'spawn_failed';
          if (String(why).startsWith('dir_missing') && !retried) { retried = true; await c.relay.retrySpawn(relayId); continue; }
          throw new Error(`the machine could not start the session: ${why}`);
        }
        if (row?.localSessionId && row.sessionKeyEnvelope) break;
      }
      if (!row?.localSessionId) throw new Error('the machine has not started the session — is its daemon online?');
      await link(row, { announce: true });
    } catch (e) {
      await set({ linkError: e?.message ?? String(e) });
      await log(`could not start a session: ${e?.message ?? e}`);
      await broadcastMeta();
      throw e;
    } finally { spawning = null; }
  })();
  return spawning;
}

/** The linked session is gone for good → start a fresh one, once. A spawn that
 *  fails parks on linkError until a person presses the button. */
async function ensureLinked() {
  const { setup, linked, linkError } = await get(['setup', 'linked', 'linkError']);
  if (!setup?.machineId || spawning) return;
  if (!linked) { if (!linkError) await startSession().catch(() => {}); return; }
  const c = await ensureClient().catch(() => null);
  if (!c) return;
  let gone = false;
  try { gone = ['archived', 'deleted', 'failed'].includes((await c.relay.sessionState(linked.sessionId)).sessionState); }
  catch (e) { gone = e?.status === 404; }
  if (!gone) return;
  await log(`session ${linked.localId} has ended — starting a fresh one`);
  await set({ linked: null, cursor: 0 }); stopWatching();
  await startSession().catch(() => {});
}

// Chrome stops an idle service worker after ~30 s, and the stream with it. The
// alarm is the floor: at worst a tag waits one period. (Firefox's background
// page does not sleep; there this is only the health check.)
api.alarms.create(ALARM, { periodInMinutes: 0.5 });
api.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) void ensureLinked().then(ensureWatching).catch(() => {}); });
api.runtime.onStartup.addListener(() => void ensureLinked().then(ensureWatching).catch(() => {}));
api.runtime.onInstalled.addListener(() => void ensureWatching());
void ensureWatching();

// ── requests from the popup and the page button ──────────────────────────────
async function machinesView() {
  const c = await ensureClient();
  const { machines = [] } = await c.relay.listMachines();
  const out = [];
  for (const m of machines) {
    const meta = await openMachineMetadata(m.metadata, openMachineKey(m.dataEncryptionKey, c.contentSecret));
    out.push({ id: m.id, name: meta?.displayName || meta?.host || m.id.slice(0, 8), online: !!(m.active || m.leaseAlive) });
  }
  return out.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

const handlers = {
  async status() {
    const s = await get(['setup', 'linked', 'paused', 'excluded', 'scripts', 'linkError', 'log', 'draft']);
    return {
      stage: !s.setup?.secret ? 'pair' : !s.setup?.machineId ? 'machine' : 'ready',
      relayUrl: s.setup?.relayUrl ?? null, machineName: s.setup?.machineName ?? null, cwd: s.setup?.cwd ?? null,
      linked: s.linked ?? null, starting: !!spawning, linkError: s.linkError ?? null, paused: !!s.paused,
      excluded: s.excluded ?? [], scripts: (s.scripts ?? []).map(({ id, name, match, code, enabled, approved }) => ({ id, name, match, code, enabled, approved })),
      log: s.log ?? [], defaultFolder: DEFAULT_FOLDER, draft: s.draft ?? null,
    };
  },
  /** Step one: prove the relay and the code, keep them, and say which machines there are. */
  async login({ relayUrl, backupCode }) {
    const { url, error } = relayAddress(relayUrl);
    if (error) throw new Error(error);
    await set({ draft: { relayUrl: String(relayUrl ?? '').trim() } }); // so a failed try does not cost the typing
    let accountSecret;
    try { accountSecret = parseBackupCode(backupCode); } catch { throw new Error('that is not a backup code — copy it from the joy app, Settings → Account'); }
    const perimeterKey = relayPerimeterKey(accountSecret);
    const wrong = await describeRelay(url, { perimeterKey });
    if (wrong) throw new Error(wrong);
    try { await loginWithSecret(url, accountSecret, { perimeterKey }); }
    catch (e) { throw new Error(e?.status === 401 || e?.status === 403 ? `${url} does not know this backup code — is it the relay this account lives on?` : `${url}: ${e?.message ?? e}`); }
    client = null;
    await set({ setup: { relayUrl: url, secret: b64(accountSecret) }, linked: null, cursor: 0, linkError: null });
    await log(`paired with ${url}`);
    return { machines: await machinesView() };
  },
  machines: async () => ({ machines: await machinesView() }),
  /** Step two: the machine and folder, then the session starts by itself. */
  async start({ machineId, machineName, cwd }) {
    const { setup } = await get('setup');
    await set({ setup: { ...setup, machineId, machineName, cwd: (cwd ?? '').trim() || DEFAULT_FOLDER }, linked: null, cursor: 0 });
    stopWatching();
    await startSession();
    return { ok: true };
  },
  async newSession() { await set({ linked: null, cursor: 0 }); stopWatching(); await startSession(); return { ok: true }; },
  /** Settings → connect to a session that already exists, by its id or a prefix. */
  async connect({ ref }) {
    const c = await ensureClient();
    const want = String(ref ?? '').trim().toLowerCase();
    if (!want) throw new Error('enter a session id');
    const rows = ((await c.relay.listSessions()).sessions ?? []).filter((s) => s.state !== 'deleted');
    const exact = rows.filter((s) => s.sessionId === want || s.localSessionId === want);
    const hits = exact.length ? exact : rows.filter((s) => s.sessionId.startsWith(want) || (s.localSessionId ?? '').startsWith(want));
    if (!hits.length) throw new Error(`no session matches "${want}"`);
    if (hits.length > 1) throw new Error(`${hits.length} sessions match "${want}" — use more of the id`);
    if (!hits[0].sessionKeyEnvelope && hits[0].encryptedMetadata) throw new Error('that session cannot be read with this account');
    await link(hits[0], { announce: true });
    return { ok: true };
  },
  async pause({ paused }) { await set({ paused: !!paused }); await log(paused ? 'paused: nothing will run' : 'resumed'); await broadcastMeta(); return { ok: true }; },
  async 'exclude:add'({ pattern }) {
    const p = normalizePattern(pattern);
    if (!p) throw new Error('that does not look like a site — try example.com or example.com/account/*');
    const { excluded = [] } = await get('excluded');
    if (!excluded.includes(p)) await set({ excluded: [...excluded, p].sort() });
    return { ok: true, pattern: p };
  },
  async 'exclude:remove'({ pattern }) { const { excluded = [] } = await get('excluded'); await set({ excluded: excluded.filter((p) => p !== pattern) }); return { ok: true }; },
  async 'scripts:set'({ id, approved, enabled, remove }) {
    const { scripts = [] } = await get('scripts');
    const next = remove ? scripts.filter((s) => s.id !== id) : scripts.map((s) => (s.id !== id ? s : { ...s, ...(approved !== undefined ? { approved: !!approved } : {}), ...(enabled !== undefined ? { enabled: !!enabled && (approved ?? s.approved) } : {}) }));
    await set({ scripts: next });
    const s = scripts.find((x) => x.id === id);
    if (s) await log(remove ? `removed saved script "${s.name}"` : `saved script "${s.name}": ${next.find((x) => x.id === id)?.enabled ? 'on' : 'off'}`);
    await broadcastMeta();
    return { ok: true };
  },
  async clear() { stopWatching(); client = null; await api.storage.local.clear(); post({ type: 'gone' }); return { ok: true }; },
  /** The page button asks: should I be here? */
  async pageState({ url }) {
    const { setup, excluded = [], fab = null, paused = false } = await get(['setup', 'excluded', 'fab', 'paused']);
    return { show: !!setup?.machineId && !matchesAny(url, excluded), fab, paused };
  },
  async 'fab:save'({ x, y }) { await set({ fab: { x, y } }); return { ok: true }; },
};

api.runtime.onMessage.addListener((msg, _sender, respond) => {
  const h = handlers[msg?.type];
  if (!h) return false;
  Promise.resolve().then(() => h(msg)).then(respond, (e) => respond({ error: e?.message ?? String(e) }));
  return true; // the answer is asynchronous
});
