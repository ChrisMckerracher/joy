import { afterEach, expect, test, vi } from 'vitest';
import { finishPocketWav, pocketEndpoint, synthesizeSpeech } from './pocketTts';

export function wav() {
  const b = Buffer.alloc(48);
  b.write('RIFF'); b.writeUInt32LE(2_000_000_036, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(2_000_000_000, 40);
  return b;
}
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

test('normalizes both streaming WAV sizes and rejects empty/non PCM payloads', () => {
  const result = finishPocketWav(wav());
  expect(result.readUInt32LE(4)).toBe(40);
  expect(result.readUInt32LE(40)).toBe(4);
  expect(() => finishPocketWav(Buffer.from('<html>error</html>'))).toThrow('invalid WAV');
  expect(() => finishPocketWav(wav().subarray(0, 44))).toThrow('empty PCM');
  const stereo = wav(); stereo.writeUInt16LE(2, 22);
  expect(() => finishPocketWav(stereo)).toThrow('unsupported');
});

test.each(['https://127.0.0.1:8000', 'http://example.com:8000', 'http://localhost:8000', 'http://100.121.220.10:8000', 'http://127.0.0.1:8000/other', 'http://user:pass@127.0.0.1:8000', 'http://127.0.0.1:8000?url=remote'])('rejects non-fixed loopback destination %s', value => {
  vi.stubEnv('JOY_POCKET_TTS_URL', value);
  expect(pocketEndpoint).toThrow();
});

test('explicit opt-in and literal loopback URLs only', () => {
  vi.stubEnv('JOY_POCKET_TTS_URL', '');
  expect(pocketEndpoint).toThrow('not configured');
  vi.stubEnv('JOY_POCKET_TTS_URL', 'http://[::1]:8001');
  expect(pocketEndpoint()).toBe('http://[::1]:8001/tts');
});

test('sends upstream form contract; ignores caller URLs; repairs WAV', async () => {
  vi.stubEnv('JOY_POCKET_TTS_URL', 'http://127.0.0.1:8000');
  const fetcher = vi.fn(async (_url, init) => {
    expect(init.body.get('text')).toBe('Hello');
    expect(init.body.get('voice_url')).toBe('alba');
    expect(init.redirect).toBe('error');
    return new Response(wav(), { headers: { 'content-type': 'audio/wav' } });
  });
  vi.stubGlobal('fetch', fetcher);
  const result = await synthesizeSpeech({ text: ' Hello ', voice: 'alba', url: 'http://evil.test', voice_url: 'http://evil.test/voice' });
  expect(fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:8000/tts');
  expect(result.readUInt32LE(40)).toBe(4);
});

test.each([{ text: '', voice: 'alba' }, { text: 'x'.repeat(501), voice: 'alba' }, { text: 'hi', voice: 'http://example.com/voice.wav' }, { text: 5, voice: 'alba' }])('validates before any network call: %j', async body => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  await expect(synthesizeSpeech(body)).rejects.toMatchObject({ status: 400 });
  expect(fetcher).not.toHaveBeenCalled();
});

test('bounds upstream data and rejects wrong content type', async () => {
  vi.stubEnv('JOY_POCKET_TTS_URL', 'http://127.0.0.1:8000');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(4 * 1024 * 1024 + 1), { headers: { 'content-type': 'audio/wav' } })));
  await expect(synthesizeSpeech({ text: 'hello', voice: 'alba' })).rejects.toThrow('size limit');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('error', { headers: { 'content-type': 'text/html' } })));
  await expect(synthesizeSpeech({ text: 'hello', voice: 'alba' })).rejects.toMatchObject({ status: 502 });
});

test('one generation at a time; cancellation frees the slot', async () => {
  vi.stubEnv('JOY_POCKET_TTS_URL', 'http://127.0.0.1:8000');
  vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  })));
  const abort = new AbortController();
  const first = synthesizeSpeech({ text: 'hello', voice: 'alba' }, abort.signal);
  const rejected = expect(first).rejects.toThrow('cancelled');
  await expect(synthesizeSpeech({ text: 'hello', voice: 'alba' })).rejects.toMatchObject({ status: 429 });
  abort.abort(); await rejected;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(wav(), { headers: { 'content-type': 'audio/wav' } })));
  await expect(synthesizeSpeech({ text: 'hello', voice: 'alba' })).resolves.toBeInstanceOf(Buffer);
});

test('times out a stalled generation', async () => {
  vi.useFakeTimers();
  vi.stubEnv('JOY_POCKET_TTS_URL', 'http://127.0.0.1:8000');
  vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  })));
  const result = expect(synthesizeSpeech({ text: 'hello', voice: 'alba' })).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(45_000); await result;
});
