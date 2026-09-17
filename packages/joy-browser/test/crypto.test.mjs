// The browser crypto must produce and open the SAME bytes as the Node client
// the MCP server uses — so each format is sealed by one and opened by the other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';

globalThis.self = globalThis; // the vendored tweetnacl attaches to `self`, as in a service worker
const B = await import('../src/crypto.js');
const N = await import('../../joy-mcp/src/crypto.mjs');

const secret = new Uint8Array(randomBytes(32));
const eq = (a, b) => assert.deepEqual([...a], [...b]);

test('HMAC-SHA512 built on nacl.hash matches node:crypto, short and long keys', () => {
  for (const keyLen of [8, 64, 128, 200]) {
    const key = new Uint8Array(randomBytes(keyLen)); const data = new Uint8Array(randomBytes(77));
    eq(B.hmac512(key, data), new Uint8Array(createHmac('sha512', key).update(data).digest()));
  }
});

test('the key tree, both keypairs and the perimeter key match the Node client', () => {
  eq(B.deriveKey(secret, 'Joy Content', ['content']), N.deriveKey(secret, 'Joy Content', ['content']));
  eq(B.contentKeyPair(secret).publicKey, N.contentKeyPair(secret).publicKey);
  eq(B.contentKeyPair(secret).secretKey, N.contentKeyPair(secret).secretKey);
  eq(B.signKeyPair(secret).publicKey, N.signKeyPair(secret).publicKey);
  assert.equal(B.relayPerimeterKey(secret), N.relayPerimeterKey(secret));
});

test('a backup code parses the same in every form the app and CLI accept', () => {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = ''; for (const b of secret) bits += b.toString(2).padStart(8, '0');
  let b32 = ''; for (let i = 0; i < bits.length; i += 5) b32 += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  const dashed = b32.match(/.{1,5}/g).join('-');
  eq(B.parseBackupCode(dashed), secret);
  eq(B.parseBackupCode(dashed.toLowerCase()), secret);
  eq(B.parseBackupCode(dashed), N.parseBackupCode(dashed));
  // base64url — including one whose alphabet uses the `-` the dashed form also uses
  const tricky = new Uint8Array(32).fill(0xfb); // encodes with '-' and '_'
  const url = Buffer.from(tricky).toString('base64url');
  assert.match(url, /[-_]/);
  eq(B.parseBackupCode(url), tricky);
  eq(B.parseBackupCode(Buffer.from(secret).toString('base64url')), secret);
  assert.throws(() => B.parseBackupCode('nonsense'));
});

test('a session key envelope sealed by the daemon side opens here', () => {
  const sessionKey = new Uint8Array(randomBytes(32));
  const envelope = N.sealSessionKeyEnvelope(sessionKey, N.contentKeyPair(secret).publicKey);
  eq(B.openSessionKeyEnvelope(envelope, B.contentKeyPair(secret).secretKey), sessionKey);
  assert.equal(B.openSessionKeyEnvelope(envelope, B.contentKeyPair(new Uint8Array(32)).secretKey), null);
});

test('prompts, records and cards cross between the two clients', () => {
  const key = new Uint8Array(randomBytes(32));
  // browser seals a prompt → the daemon-side client opens it
  assert.deepEqual(N.openPayload(B.sealText('héllo <b> & "q"', key), key), { t: 'plain', text: 'héllo <b> & "q"', attachments: [] });
  // a record sealed the daemon's way → the browser opens it
  const record = { role: 'agent', content: { type: 'event', data: { ev: { t: 'text', text: 'hi' }, turn: 't1' } } };
  assert.deepEqual(B.openPayload(N.sealV2Json({ v: 1, t: 'record', record }, key), key), { t: 'record', record });
  assert.deepEqual(B.openCard(N.sealCard({ path: '/x', summary: { text: 'T' } }, key), key), { path: '/x', summary: { text: 'T' } });
  assert.equal(B.openPayload(B.sealText('x', key), new Uint8Array(32)), null); // wrong key
  // a plaintext session (no key): stored as sent
  assert.deepEqual(B.openPayload(B.sealText('plain', null), null), { t: 'plain', text: 'plain' });
});
