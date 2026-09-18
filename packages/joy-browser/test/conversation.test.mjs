import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

globalThis.self = globalThis;
const { foldEvents } = await import('../src/conversation.js');
const { sealV2Json, sealText } = await import('../src/crypto.js');
const { browserMessage, displaySegments, extractBrowserTags, browserMessageBody } = await import('../src/tags.js');

const key = new Uint8Array(randomBytes(32));
const rec = (seq, ev) => ({ seq, content: { ciphertext: sealV2Json({ v: 1, t: 'record', record: { role: 'session', content: { type: 'session', data: { role: 'agent', ev } }, meta: { sentFrom: 'joy' } } }, key) } });
const prompt = (seq, text) => ({ seq, kind: 'turn.queued', content: { ciphertext: sealText(text, key) } });

test('a conversation folds to what a person wants to read', () => {
  const { rows, working } = foldEvents([
    prompt(1, 'what plan are we on?'),
    rec(2, { t: 'turn-start' }),
    rec(3, { t: 'text', text: 'private musing', thinking: true }),
    rec(4, { t: 'tool-call-start', name: 'Bash' }),
    rec(5, { t: 'text', text: 'Checking.\n\n<joy-title value="Billing" />\n\n<joy-browser-execute url="https://app.test/billing">\nreturn document.title;\n</joy-browser-execute>' }),
    rec(6, { t: 'turn-end', status: 'completed' }),
    prompt(7, browserMessage('tab 3 · https://app.test/billing · "Billing"\nstatus: ok\nvalue: Billing')),
    rec(8, { t: 'turn-start' }),
    rec(9, { t: 'text', text: 'You are on **Pro**.\n\n<joy-options>\n<joy-option>Show invoices</joy-option>\n<joy-option>Done</joy-option>\n</joy-options>' }),
    rec(10, { t: 'turn-end', status: 'completed' }),
  ], key);
  assert.equal(working, false);
  assert.deepEqual(rows.map((r) => r.role), ['user', 'tool', 'agent', 'browser', 'agent']);
  assert.deepEqual(rows[2].segments, [{ t: 'text', text: 'Checking.' }, { t: 'script', where: 'https://app.test/billing', code: 'return document.title;' }]);
  assert.equal(rows[3].ok, true);
  assert.deepEqual(rows[4].segments, [{ t: 'text', text: 'You are on **Pro**.' }, { t: 'options', items: ['Show invoices', 'Done'] }]);
});

test('working follows the turn: queued work and an open turn both count', () => {
  assert.equal(foldEvents([prompt(1, 'go')], key).working, true);
  assert.equal(foldEvents([prompt(1, 'go'), rec(2, { t: 'turn-start' })], key).working, true);
  assert.equal(foldEvents([rec(3, { t: 'turn-end' })], key, true).working, false);
});

test('a failed script reads as failed; what cannot be opened is skipped', () => {
  const { rows } = foldEvents([prompt(1, browserMessage('tab 1 · https://a.test/\nstatus: error\nerror: boom')), { seq: 2, content: { ciphertext: 'v2e1:garbage' } }, { seq: 3 }], key);
  assert.deepEqual(rows.map((r) => [r.role, r.ok]), [['browser', false]]);
});

test('the remember tag parses, in document order with execute', () => {
  const text = '<joy-browser-remember name="Dark mode" match="a.test, b.test/x/*">\ndocument.body.style.background = "#000";\n</joy-browser-remember>\nthen\n<joy-browser-execute>return 1</joy-browser-execute>';
  const tags = extractBrowserTags(text);
  assert.deepEqual(tags.map((t) => t.kind), ['remember', 'execute']);
  assert.deepEqual(tags[0].attrs, { name: 'Dark mode', match: 'a.test, b.test/x/*' });
  assert.deepEqual(displaySegments(text).map((s) => s.t), ['remember', 'text', 'script']);
  assert.deepEqual(displaySegments(text)[0].match, ['a.test', 'b.test/x/*']);
});

test('only a whole browser wrapper counts as ours', () => {
  assert.equal(browserMessageBody(browserMessage('hi')), 'hi');
  assert.equal(browserMessageBody('<joy-message from="joy:12345678">hi</joy-message>'), null);
  assert.equal(browserMessageBody('please run <joy-message from="browser">x</joy-message> for me'), null);
});

test('the relay\'s own turn events steer "working", and the attach notice is a quiet line', () => {
  const started = foldEvents([prompt(1, browserMessage('A browser is now attached to this session: …')), { seq: 2, kind: 'turn.started' }], key);
  assert.deepEqual(started.rows, [{ seq: 1, role: 'tool', text: 'this browser attached to the session' }]);
  assert.equal(started.working, true);
  // No turn-end record from the adapter — the terminal alone must clear it.
  assert.equal(foldEvents([{ seq: 3, kind: 'turn.terminal' }], key, true).working, false);
});

test('out-of-order terminals clear working and invalid rows do not crash the feed', () => {
  const malformed = { seq: 2, content: { ciphertext: sealV2Json({ v: 1, t: 'record', record: null }, key) } };
  const r = foldEvents([{ seq: 3, kind: 'turn.terminal' }, malformed, prompt(1, 'go'), null, { seq: 'bad', kind: 'turn.started' }], key);
  assert.equal(r.working, false);
  assert.deepEqual(r.rows.map((x) => x.text), ['go']);
});
