// STUN binding responder (RFC 8489 §6.3.1, Binding method only): the one
// thing a peer behind NAT cannot learn by itself is the public address:port
// its NAT maps it to. The app and the daemon each ask here, put the answer in
// the (sealed) offer/answer they swap through the tunnel, and ICE punches
// between those addresses. This is what makes the relay a hole puncher; it
// never sees the peer traffic that follows.
//
// Deliberately minimal: no authentication (a binding response only echoes the
// requester's own address), no attributes read from the request, one
// XOR-MAPPED-ADDRESS + FINGERPRINT back. The response (40 bytes for IPv4) is
// at most 2x the smallest request, so the port is a poor amplifier; requests
// that are not a well-formed Binding request get no answer at all.
import dgram from 'node:dgram';
import { crc32 } from 'node:zlib';

export const MAGIC_COOKIE = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;
const ATTR_FINGERPRINT = 0x8028;
const FINGERPRINT_XOR = 0x5354554e;
const HEADER = 20;
// A Binding request from ICE carries USERNAME/PRIORITY/etc. only peer to
// peer; to a server it is typically bare or carries SOFTWARE/FINGERPRINT.
// Anything longer is not a request we need to answer.
const MAX_REQUEST = 548;

/** The Binding success response for `req` (a Buffer) seen from `address:port`,
 *  or null when `req` is not a well-formed Binding request. */
export function bindingResponse(req, address, port) {
  if (req.length < HEADER || req.length > MAX_REQUEST) return null;
  if ((req[0] & 0xc0) !== 0) return null;                 // top two bits must be zero
  if (req.readUInt16BE(0) !== BINDING_REQUEST) return null;
  const length = req.readUInt16BE(2);
  if (length % 4 !== 0 || HEADER + length !== req.length) return null;
  if (req.readUInt32BE(4) !== MAGIC_COOKIE) return null;
  const txId = req.subarray(8, 20);

  const v6 = address.includes(':');
  const addrBytes = v6 ? ipv6Bytes(address) : ipv4Bytes(address);
  if (!addrBytes) return null;
  const mask = Buffer.alloc(16);
  mask.writeUInt32BE(MAGIC_COOKIE, 0);
  txId.copy(mask, 4);
  const xAddr = Buffer.from(addrBytes.map((b, i) => b ^ mask[i]));

  const mapped = Buffer.alloc(4 + 4 + xAddr.length);
  mapped.writeUInt16BE(ATTR_XOR_MAPPED_ADDRESS, 0);
  mapped.writeUInt16BE(4 + xAddr.length, 2);
  mapped.writeUInt8(0, 4);
  mapped.writeUInt8(v6 ? 0x02 : 0x01, 5);
  mapped.writeUInt16BE(port ^ (MAGIC_COOKIE >>> 16), 6);
  xAddr.copy(mapped, 8);

  const fingerprintLen = 8;
  const head = Buffer.alloc(HEADER);
  head.writeUInt16BE(BINDING_SUCCESS, 0);
  head.writeUInt16BE(mapped.length + fingerprintLen, 2);
  head.writeUInt32BE(MAGIC_COOKIE, 4);
  txId.copy(head, 8);
  const body = Buffer.concat([head, mapped]);
  const fp = Buffer.alloc(fingerprintLen);
  fp.writeUInt16BE(ATTR_FINGERPRINT, 0);
  fp.writeUInt16BE(4, 2);
  fp.writeUInt32BE((crc32(body) ^ FINGERPRINT_XOR) >>> 0, 4);
  return Buffer.concat([body, fp]);
}

function ipv4Bytes(a) {
  const m = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (!m) return null;
  const b = m.slice(1).map(Number);
  return b.every((x) => x <= 255) ? b : null;
}

function ipv6Bytes(a) {
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/.test(a)) return null; // dual-stack v4, answered as v4 above
  const [head, tail = ''] = a.split('::');
  const h = head ? head.split(':') : [];
  const t = a.includes('::') ? (tail ? tail.split(':') : []) : [];
  const groups = a.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  if (groups.length !== 8) return null;
  const out = [];
  for (const g of groups) {
    const n = parseInt(g, 16);
    if (!/^[0-9a-f]{1,4}$/i.test(g) || Number.isNaN(n)) return null;
    out.push(n >> 8, n & 0xff);
  }
  return out;
}

/** Answer Binding requests on `host:port`. Resolves once bound. */
export function startStunServer({ host = '0.0.0.0', port = 3478, log = () => {} } = {}) {
  const sock = dgram.createSocket({ type: host.includes(':') ? 'udp6' : 'udp4' });
  sock.on('message', (msg, rinfo) => {
    const address = rinfo.address.startsWith('::ffff:') ? rinfo.address.slice(7) : rinfo.address;
    const res = bindingResponse(msg, address, rinfo.port);
    if (res) sock.send(res, rinfo.port, rinfo.address);
  });
  sock.on('error', (e) => log(`[stun] ${e.message}`));
  return new Promise((resolve, reject) => {
    sock.once('error', reject);
    sock.bind(port, host, () => {
      sock.off('error', reject);
      resolve({
        port: sock.address().port,
        close: () => new Promise((r) => sock.close(() => r())),
      });
    });
  });
}
