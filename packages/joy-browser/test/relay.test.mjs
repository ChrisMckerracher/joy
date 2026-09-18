import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

globalThis.self = globalThis;
const { relayAddress, describeRelay } = await import('../src/relay.js');

test('a typed relay address becomes a URL, or a reason it cannot', () => {
  assert.deepEqual(relayAddress(' relay.example.com:4997 '), { url: 'https://relay.example.com:4997' });
  assert.deepEqual(relayAddress('http://localhost:4997/'), { url: 'http://localhost:4997' });
  assert.deepEqual(relayAddress('https://joy.example.com'), { url: 'https://joy.example.com' });
  assert.match(relayAddress('').error, /enter/);
  assert.match(relayAddress('joy').error, /not a full address/);           // an alias, not a host
  assert.match(relayAddress('relay.example.com/joy/v2').error, /without a path/);
  assert.match(relayAddress('http://').error, /not a full address/);
  assert.match(relayAddress('http://:4997').error, /not an address/);
});

test('describeRelay says what is at the address, in words a person can act on', async () => {
  const answers = { '/ok/joy/v2/capabilities': [200, { relay: 'joy-relay' }], '/other/joy/v2/capabilities': [200, { hello: 'world' }], '/gated/joy/v2/capabilities': [403, { error: 'relay_key_required' }], '/broken/joy/v2/capabilities': [500, {}] };
  const srv = createServer((req, res) => { const [code, body] = answers[req.url] ?? [404, {}]; res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.equal(await describeRelay(`${base}/ok`), null);
    assert.match(await describeRelay(`${base}/other`), /not a joy relay/);
    assert.match(await describeRelay(`${base}/gated`), /access key/);
    assert.match(await describeRelay(`${base}/broken`), /answered 500/);
    assert.match(await describeRelay('http://127.0.0.1:1'), /could not reach http:\/\/127\.0\.0\.1:1 \(.+\)\. Check the address/);
    const slow = createServer(() => { /* never answers */ }); await new Promise((r) => slow.listen(0, '127.0.0.1', r));
    try { assert.match(await describeRelay(`http://127.0.0.1:${slow.address().port}`, { timeoutMs: 300 }), /did not answer within/); } finally { slow.closeAllConnections(); slow.close(); }
  } finally { srv.close(); }
});
