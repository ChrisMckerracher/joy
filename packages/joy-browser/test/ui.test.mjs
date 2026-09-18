import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

const flush = () => new Promise((r) => setImmediate(r));
const event = () => { const listeners = []; return { addListener: (f) => listeners.push(f), fire: (...a) => listeners.forEach((f) => f(...a)) }; };
function dom() {
  const nodes = [];
  class Node {
    constructor(tag) { this.tag = tag; this.children = []; this.className = ''; this.value = ''; this.style = { setProperty() {} }; this.scrollHeight = this.clientHeight = 100; this.scrollTop = 0; nodes.push(this); }
    append(...children) { this.children.push(...children); for (const c of children) if (typeof c === 'object') c.parent = this; }
    appendChild(child) { this.append(child); return child; }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    replaceWith(child) { this.parent.children[this.parent.children.indexOf(this)] = child; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); }
    attachShadow() { return this.appendChild(new Node('shadow')); }
    setPointerCapture() {} releasePointerCapture() {} focus() {}
    get classList() { return { toggle: (c, on) => { const all = new Set(this.className.split(' ')); if (on) all.add(c); else all.delete(c); this.className = [...all].filter(Boolean).join(' '); } }; }
    click() { if (!this.disabled) return this.onclick?.(); }
    get textContent() { return [this.text ?? '', ...this.children.map((c) => typeof c === 'string' ? c : c.textContent)].join(''); }
    set textContent(text) { this.text = text; this.children = []; }
  }
  const app = new Node('app'); const body = new Node('body'); body.append(app);
  const document = { body, documentElement: { clientWidth: 1100, clientHeight: 800 }, createElement: (t) => new Node(t), getElementById: () => app };
  return { document, nodes, app, find: (tag, text) => nodes.findLast((n) => n.tag === tag && (text === undefined || n.textContent === text)) };
}
async function panel({ connectFails = false, crypto = webcrypto } = {}) {
  const d = dom(); const ports = []; const timeouts = new Map(); const intervals = []; let next = 0;
  const api = { storage: { onChanged: event() }, runtime: {
    sendMessage: async () => ({ show: true }),
    connect: () => {
      if (connectFails) throw Error('worker missing');
      const p = { messages: [], onMessage: event(), onDisconnect: event(), postMessage(m) { this.messages.push(m); }, disconnect() { this.onDisconnect.fire(); } };
      ports.push(p); return p;
    },
  } };
  const context = vm.createContext({ chrome: api, crypto, document: d.document, console, screen: { width: 1100, height: 800 }, matchMedia: () => ({ matches: false }), innerWidth: 1100, innerHeight: 800, visualViewport: null,
    addEventListener() {}, removeEventListener() {}, location: { href: 'https://site.test', hostname: 'site.test' },
    setTimeout(fn, ms) { const id = ++next; timeouts.set(id, { fn, ms }); return id; }, clearTimeout(id) { timeouts.delete(id); }, setInterval(fn) { intervals.push(fn); return intervals.length; }, clearInterval() {},
  });
  vm.runInContext('globalThis.window = globalThis; globalThis.top = globalThis;', context);
  vm.runInContext(readFileSync(new URL('../content.js', import.meta.url), 'utf8'), context); await flush();
  const state = { type: 'state', session: { sessionId: 's', localId: 'abc' }, rows: [], working: false };
  const status = () => d.nodes.find((n) => n.className.startsWith('status')).textContent;
  const submit = (text) => { d.find('textarea').value = text; d.find('form').onsubmit({ preventDefault() {} }); };
  return { ...d, ports, timeouts, intervals, state, status, submit };
}

test('failed send retains its draft and retry intent; acceptance clears it without a false working state', async () => {
  const r = await panel(); const p = r.ports[0]; p.onMessage.fire(r.state);
  r.submit('please click'); const sent = p.messages.at(-1);
  assert.equal(r.find('textarea').value, 'please click');
  assert.equal(r.status(), 'Sending…');
  p.onMessage.fire({ type: 'error', id: sent.id, message: 'relay unavailable' });
  assert.equal(r.status(), 'relay unavailable'); assert.equal(r.find('textarea').value, 'please click');
  r.submit('please click'); assert.equal(p.messages.at(-1).id, sent.id);
  p.onMessage.fire({ type: 'sent', id: sent.id });
  assert.equal(r.find('textarea').value, ''); assert.equal(r.status(), '');
});

test('an acknowledgement does not erase a newer draft', async () => {
  const r = await panel(); const p = r.ports[0]; p.onMessage.fire(r.state);
  r.submit('first'); const id = p.messages.at(-1).id;
  r.find('textarea').value = 'second'; p.onMessage.fire({ type: 'sent', id });
  assert.equal(r.find('textarea').value, 'second');
});

test('a dead port is visible, reconnects while open, and ignores stale callbacks', async () => {
  const r = await panel(); const p = r.ports[0]; p.onMessage.fire(r.state);
  const fab = r.nodes.find((n) => n.className === 'fab');
  fab.onpointerdown({ clientX: 0, clientY: 0 }); fab.onpointerup({});
  r.submit('keep this'); p.disconnect();
  assert.match(r.status(), /Disconnected/); assert.equal(r.find('textarea').value, 'keep this');
  [...r.timeouts.values()].find((t) => t.ms === 600).fn();
  const next = r.ports[1]; next.onMessage.fire(r.state);
  p.onMessage.fire({ type: 'error', message: 'stale error' });
  assert.equal(r.status(), '');
  p.onDisconnect.fire(); r.submit('keep this');
  assert.equal(next.messages.at(-1).type, 'send'); assert.equal(next.messages.at(-1).id, p.messages.at(-1).id);
});

test('runtime.connect failure is shown instead of a healthy-looking empty panel', async () => {
  const r = await panel({ connectFails: true }); assert.match(r.status(), /Disconnected/);
});

test('panel approval carries the code revision it actually displayed', async () => {
  const r = await panel(); const p = r.ports[0];
  p.onMessage.fire({ ...r.state, pending: [{ id: 'script', revision: 'shown', name: 'x', code: 'return 1', match: ['a.test'] }] });
  r.find('button', 'Approve').click(); assert.equal(p.messages.at(-1).revision, 'shown');
});

test('sending works on insecure pages where randomUUID is unavailable', async () => {
  const r = await panel({ crypto: { getRandomValues: (a) => webcrypto.getRandomValues(a) } }); r.ports[0].onMessage.fire(r.state);
  r.submit('from http'); assert.ok(r.ports[0].messages.at(-1).id);
});

test('popup machine-list failure stops after one request and offers a retry', async () => {
  const d = dom(); let calls = 0;
  const api = { storage: { onChanged: event() }, runtime: { sendMessage: async ({ type }) => {
    if (type === 'status') return { stage: 'machine', defaultFolder: '~/x' };
    if (type === 'machines') { calls++; return { error: 'relay down' }; }
  } } };
  const ctx = vm.createContext({ chrome: api, document: d.document, console, setTimeout, clearTimeout });
  vm.runInContext(readFileSync(new URL('../popup.js', import.meta.url), 'utf8'), ctx);
  await flush(); assert.equal(calls, 1); assert.match(d.app.textContent, /relay down/); assert.ok(d.find('button', 'Retry'));
});

test('popup unavailable background shows a recoverable error without an unhandled rejection', async () => {
  const d = dom(); const api = { storage: { onChanged: event() }, runtime: { sendMessage: async () => { throw Error('background unavailable'); } } };
  vm.runInNewContext(readFileSync(new URL('../popup.js', import.meta.url), 'utf8'), { chrome: api, document: d.document, console, setTimeout, clearTimeout });
  await flush(); assert.match(d.app.textContent, /background unavailable/); assert.ok(d.find('button', 'Retry'));
  // and the one screen that needs no background: what to paste when asking for help
  assert.match(d.app.textContent, /Diagnostics/); assert.match(d.find('pre').textContent, /"backgroundError": "background unavailable"/); assert.ok(d.find('button', 'Copy'));
});

test('a lost acknowledgement times out independently of a healthy port', async () => {
  const r = await panel(); const p = r.ports[0]; p.onMessage.fire(r.state);
  r.submit('keep my request'); const sent = p.messages.at(-1);
  p.onMessage.fire({ type: 'pong' });
  [...r.timeouts.values()].find((t) => t.ms === 45000).fn();
  assert.match(r.status(), /not confirmed/); assert.equal(r.find('textarea').value, 'keep my request');
  r.submit('keep my request'); assert.equal(p.messages.at(-1).id, sent.id);
});

test('a recovered relay clears its old error while a failed send remains visible', async () => {
  const r = await panel(); const p = r.ports[0]; p.onMessage.fire(r.state);
  p.onMessage.fire({ type: 'error', message: 'relay down' }); assert.equal(r.status(), 'relay down');
  p.onMessage.fire(r.state); assert.equal(r.status(), '');
  r.submit('draft'); p.onMessage.fire({ type: 'error', id: p.messages.at(-1).id, message: 'send failed' });
  p.onMessage.fire(r.state); assert.equal(r.status(), 'send failed');
});
