import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startHttpServer } from './http';
import type { SessionRegistry } from '../domain/registry';

let upstream: Server;
let daemon: Server;
let base: string;
let requests = 0;
let posted = '';
beforeAll(async () => {
  upstream = createServer(async (req, res) => {
    requests++;
    for await (const chunk of req) posted += chunk.toString();
    const audio = Buffer.alloc(48);
    audio.write('RIFF'); audio.writeUInt32LE(2_000_000_036, 4); audio.write('WAVEfmt ', 8);
    audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
    audio.writeUInt32LE(24000, 24); audio.writeUInt32LE(48000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
    audio.write('data', 36); audio.writeUInt32LE(2_000_000_000, 40);
    res.writeHead(200, { 'content-type': 'audio/wav' });
    res.write(audio.subarray(0, 30)); res.end(audio.subarray(30));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  vi.stubEnv('JOY_POCKET_TTS_URL', `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`);
  base = await new Promise<string>(resolve => {
    daemon = startHttpServer({ registry: {} as SessionRegistry, token: 'voice-test', port: 0, publicDir: '/tmp', onListening: port => resolve(`http://127.0.0.1:${port}`) });
  });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await Promise.all([daemon, upstream].filter(Boolean).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
});
test('requires daemon authentication before synthesis', async () => {
  const response = await fetch(base + '/v2/voice/speech', { method: 'POST', body: JSON.stringify({ text: 'hello', voice: 'alba' }) });
  expect(response.status).toBe(401); expect(requests).toBe(0);
});
test('authenticated route adapts JSON to Pocket form and returns corrected binary WAV', async () => {
  const response = await fetch(base + '/v2/voice/speech', { method: 'POST', headers: { 'x-joy-token': 'voice-test', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hello', voice: 'alba' }) });
  expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('audio/wav');
  expect(response.headers.get('cache-control')).toBe('no-store');
  const audio = Buffer.from(await response.arrayBuffer());
  expect(audio.readUInt32LE(4)).toBe(audio.length - 8); expect(audio.readUInt32LE(40)).toBe(4);
  expect(posted).toContain('name="text"\r\n\r\nhello'); expect(posted).toContain('name="voice_url"\r\n\r\nalba');
});
test('rejects voice URLs without contacting upstream', async () => {
  const before = requests;
  const response = await fetch(base + '/v2/voice/speech', { method: 'POST', headers: { 'x-joy-token': 'voice-test' }, body: JSON.stringify({ text: 'hello', voice: 'http://example.com/voice.wav' }) });
  expect(response.status).toBe(400); expect(requests).toBe(before);
});
