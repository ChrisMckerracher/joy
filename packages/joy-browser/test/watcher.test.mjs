import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

globalThis.self = globalThis;
const { Watcher, agentTextOf } = await import('../src/watcher.js');
const { sealV2Json, sealText, openPayload } = await import('../src/crypto.js');

const key = new Uint8Array(randomBytes(32));
const TAG = (code) => `<joy-browser-execute>\n${code}\n</joy-browser-execute>`;
const agentText = (seq, text, extra = {}) => ({ seq, kind: 'output', content: { ciphertext: sealV2Json({ v: 1, t: 'record', record: { role: 'agent', content: { type: 'event', data: { ev: { t: 'text', text, ...extra } } } } }, key) } });
const userPrompt = (seq, text) => ({ seq, kind: 'turn.queued', content: { ciphertext: sealText(text, key) } });
const mirroredUser = (seq, text) => ({ seq, kind: 'output', content: { ciphertext: sealV2Json({ v: 1, t: 'record', record: { role: 'user', content: { type: 'text', text } } }, key) } });
const legacyPlain = (seq, text) => ({ seq, kind: 'output', content: { ciphertext: sealText(text, key) } });

function rig(events, { cursor = 0, execute } = {}) {
  const sent = []; const ran = []; const saved = [];
  const state = { sessionId: 's1', key, cursor };
  const relay = {
    events: async (_id, after) => ({ messages: events.filter((e) => e.seq > after) }),
    sendCiphertext: async (_id, ct) => { sent.push(openPayload(ct, key).text); return {}; },
  };
  const store = { load: async () => ({ ...state }), saveCursor: async (n) => { saved.push(n); state.cursor = n; } };
  const w = new Watcher({ relay, store, execute: execute ?? (async (tag) => { ran.push(tag.code); return { tab: { id: 1, url: 'https://a.test/' }, value: '"ok"' }; }) });
  return { w, sent, ran, saved, state };
}

test("the agent's tag runs and the answer goes back sealed, as a browser message", async () => {
  const r = rig([agentText(1, `On it.\n\n${TAG('return document.title')}`)]);
  await r.w.poll();
  assert.deepEqual(r.ran, ['return document.title']);
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0], /^<joy-message from="browser">\ntab 1 · https:\/\/a\.test\/\nstatus: ok\nvalue: "ok"\n<\/joy-message>$/);
});

test('only the agent speaks: prompts, mirrored user text, legacy plain and thinking never run', async () => {
  const r = rig([
    userPrompt(1, TAG('alert("from a prompt")')),
    mirroredUser(2, TAG('alert("typed in the terminal")')),
    legacyPlain(3, TAG('alert("legacy plain payload")')),
    agentText(4, TAG('alert("thinking out loud")'), { thinking: true }),
  ]);
  await r.w.poll();
  assert.deepEqual(r.ran, []);
  assert.deepEqual(r.sent, []);
  assert.equal(r.state.cursor, 4, 'they are still consumed');
});

test('its own answer cannot re-trigger it, even when a page printed a tag into the result', async () => {
  const events = [agentText(1, TAG('return 1'))];
  const r = rig(events, { execute: async () => ({ tab: null, value: TAG('alert("echo")') }) });
  await r.w.poll();
  // The relay queues the answer as a prompt — feed it back the way it arrives.
  events.push(userPrompt(2, r.sent[0]));
  await r.w.poll();
  assert.equal(r.sent.length, 1, 'one run, one answer, no loop');
});

test('history is not news: nothing at or below the cursor runs', async () => {
  const r = rig([agentText(5, TAG('return "old"')), agentText(6, TAG('return "new"'))], { cursor: 5 });
  await r.w.poll();
  assert.deepEqual(r.ran, ['return "new"']);
});

test('at most once: the cursor is saved before the script runs', async () => {
  let cursorWhenRun = null;
  const r = rig([agentText(3, TAG('return 1'))], { execute: async () => { cursorWhenRun = r.state.cursor; throw new Error('worker died mid-run'); } });
  await r.w.poll();
  assert.equal(cursorWhenRun, 3);
  assert.match(r.sent[0], /status: error\nerror: worker died mid-run/, 'a throwing executor is still answered');
  await r.w.poll();
  assert.equal(r.sent.length, 1, 'and never run a second time');
});

test('several tags in one message are answered together, in order', async () => {
  const r = rig([agentText(1, `${TAG('return "a"')}\n${TAG('return "b"')}`)]);
  await r.w.poll();
  assert.deepEqual(r.ran, ['return "a"', 'return "b"']);
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0], /\[result 1 of 2\][\s\S]*\[result 2 of 2\]/);
});

test('overlapping polls do not double-run: a poke during a poll asks for one more pass', async () => {
  const events = [agentText(1, TAG('return 1'))];
  let release; const gate = new Promise((res) => { release = res; });
  const r = rig(events, { execute: async (tag) => { await gate; return { tab: null, value: tag.code }; } });
  const first = r.w.poll();
  const second = r.w.poll(); // arrives mid-run
  events.push(agentText(2, TAG('return 2')));
  release();
  await Promise.all([first, second]);
  assert.equal(r.sent.length, 2, 'both tags answered, each exactly once');
});

test('nothing attached, nothing fetched', async () => {
  let fetched = false;
  const w = new Watcher({ relay: { events: async () => { fetched = true; return { messages: [] }; } }, store: { load: async () => null, saveCursor: async () => {} }, execute: async () => ({}) });
  await w.poll();
  assert.equal(fetched, false);
});

test('agentTextOf refuses what it cannot open', () => {
  assert.equal(agentTextOf({ seq: 1, kind: 'output', content: { ciphertext: sealText('x', key) } }, new Uint8Array(32)), null);
  assert.equal(agentTextOf({ seq: 1 }, key), null);
});

test('a remember tag is saved, not run, and answered in order with what did run', async () => {
  const remembered = [];
  const events = [agentText(1, `<joy-browser-remember name="Tidy" match="a.test">\ndocument.title = "x";\n</joy-browser-remember>\n${TAG('return 1')}`)];
  const sent = []; const ran = [];
  const state = { sessionId: 's1', key, cursor: 0 };
  const w = new Watcher({
    relay: { events: async (_i, after) => ({ messages: events.filter((e) => e.seq > after) }), sendCiphertext: async (_i, ct) => { sent.push(openPayload(ct, key).text); } },
    store: { load: async () => ({ ...state }), saveCursor: async (n) => { state.cursor = n; } },
    execute: async (tag) => { ran.push(tag.code); return { tab: null, value: '1' }; },
    remember: async (tag) => { remembered.push(tag.attrs.name); return { note: `saved "${tag.attrs.name}" — waiting for the user to approve it` }; },
  });
  await w.poll();
  assert.deepEqual(remembered, ['Tidy']);
  assert.deepEqual(ran, ['return 1'], 'the remembered script itself never ran');
  assert.match(sent[0], /\[result 1 of 2\] saved "Tidy" — waiting for the user to approve it\n\n\[result 2 of 2\] no tab\nstatus: ok/);
});

test('the chat sees new events before anything in them runs, and only once', async () => {
  const seen = []; const order = [];
  const events = [agentText(1, TAG('return 1')), agentText(2, 'plain words')];
  const state = { sessionId: 's1', key, cursor: 0 };
  const w = new Watcher({
    relay: { events: async (_i, after) => ({ messages: events.filter((e) => e.seq > after) }), sendCiphertext: async () => {} },
    store: { load: async () => ({ ...state }), saveCursor: async (n) => { state.cursor = n; } },
    execute: async () => { order.push('ran'); return { tab: null, value: '1' }; },
    onEvents: (evs) => { order.push('seen'); seen.push(...evs.map((e) => e.seq)); },
  });
  await w.poll(); await w.poll();
  assert.deepEqual(seen, [1, 2]);
  assert.deepEqual(order.slice(0, 2), ['seen', 'ran']);
});
