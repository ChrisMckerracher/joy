// The relay's STUN responder (src/stun.mjs): peers behind NAT learn their
// public address here before punching a direct tunnel. Checked against the
// wire format of RFC 8489 by decoding real responses, over real UDP.
import { describe, it, expect, afterEach } from 'vitest';
import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { bindingResponse, startStunServer, MAGIC_COOKIE } from '../src/stun.mjs';

function bindingRequest(txId = randomBytes(12), attrs = Buffer.alloc(0)) {
  const h = Buffer.alloc(20);
  h.writeUInt16BE(0x0001, 0);
  h.writeUInt16BE(attrs.length, 2);
  h.writeUInt32BE(MAGIC_COOKIE, 4);
  txId.copy(h, 8);
  return Buffer.concat([h, attrs]);
}

/** Decode a Binding success response: txId, mapped address, fingerprint ok. */
function decode(res) {
  expect(res.readUInt16BE(0)).toBe(0x0101);
  expect(res.readUInt32BE(4)).toBe(MAGIC_COOKIE);
  expect(res.readUInt16BE(2)).toBe(res.length - 20);
  const txId = res.subarray(8, 20);
  let off = 20; let mapped = null; let fingerprintOk = false;
  while (off < res.length) {
    const type = res.readUInt16BE(off); const len = res.readUInt16BE(off + 2); const v = res.subarray(off + 4, off + 4 + len);
    if (type === 0x0020) {
      const port = v.readUInt16BE(2) ^ (MAGIC_COOKIE >>> 16);
      const mask = Buffer.concat([Buffer.alloc(4), txId]); mask.writeUInt32BE(MAGIC_COOKIE, 0);
      const bytes = [...v.subarray(4)].map((b, i) => b ^ mask[i]);
      const address = v[1] === 0x01 ? bytes.join('.') : bytes.reduce((a, b, i) => a + (i % 2 ? b.toString(16).padStart(2, '0') : (i ? ':' : '') + b.toString(16).padStart(2, '0')), '');
      mapped = { family: v[1], address, port };
    }
    if (type === 0x8028) fingerprintOk = v.readUInt32BE(0) === ((crc32(res.subarray(0, off)) ^ 0x5354554e) >>> 0);
    off += 4 + len + ((4 - (len % 4)) % 4);
  }
  return { txId, mapped, fingerprintOk };
}

describe('stun: binding responses', () => {
  it('echoes the transaction and the requester address, XORed, with a valid fingerprint', () => {
    const tx = randomBytes(12);
    const d = decode(bindingResponse(bindingRequest(tx), '203.0.113.7', 41000));
    expect(Buffer.compare(d.txId, tx)).toBe(0);
    expect(d.mapped).toEqual({ family: 0x01, address: '203.0.113.7', port: 41000 });
    expect(d.fingerprintOk).toBe(true);
  });

  it('answers IPv6 requesters with an IPv6 mapped address', () => {
    const d = decode(bindingResponse(bindingRequest(), '2001:db8::1', 5000));
    expect(d.mapped.family).toBe(0x02);
    expect(d.mapped.address).toBe('2001:0db8:0000:0000:0000:0000:0000:0001');
    expect(d.mapped.port).toBe(5000);
  });

  it('ignores anything that is not a well-formed Binding request', () => {
    const good = bindingRequest();
    const wrongMethod = Buffer.from(good); wrongMethod.writeUInt16BE(0x0003, 0);
    const wrongCookie = Buffer.from(good); wrongCookie.writeUInt32BE(0xdeadbeef, 4);
    const badLength = Buffer.from(good); badLength.writeUInt16BE(8, 2);
    const response = Buffer.from(good); response.writeUInt16BE(0x0101, 0);
    for (const b of [Buffer.alloc(0), good.subarray(0, 19), wrongMethod, wrongCookie, badLength, response, Buffer.alloc(600)]) {
      expect(bindingResponse(b, '203.0.113.7', 1)).toBeNull();
    }
  });

  it('is a poor amplifier: the response is at most twice the request', () => {
    const req = bindingRequest();
    expect(bindingResponse(req, '203.0.113.7', 1).length).toBeLessThanOrEqual(2 * req.length);
  });
});

describe('stun: the UDP server', () => {
  let server = null;
  afterEach(async () => { await server?.close(); server = null; });

  it('answers a real client with the address and port it sent from', async () => {
    server = await startStunServer({ host: '127.0.0.1', port: 0 });
    const sock = dgram.createSocket('udp4');
    await new Promise((r) => sock.bind(0, '127.0.0.1', r));
    const myPort = sock.address().port;
    const tx = randomBytes(12);
    const res = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no STUN answer')), 2000);
      sock.once('message', (m) => { clearTimeout(t); resolve(m); });
      sock.send(bindingRequest(tx), server.port, '127.0.0.1');
    });
    sock.close();
    const d = decode(res);
    expect(Buffer.compare(d.txId, tx)).toBe(0);
    expect(d.mapped).toEqual({ family: 0x01, address: '127.0.0.1', port: myPort });
  });
});
