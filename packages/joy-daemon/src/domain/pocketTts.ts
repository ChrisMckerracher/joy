/** Pocket TTS stays on loopback. Only this fixed operation crosses Joy's
 * authenticated, encrypted machine tunnel; clients cannot choose a URL. */
export const POCKET_VOICES = ['alba', 'marius', 'javert', 'jean', 'fantine', 'cosette', 'eponine', 'azelma'] as const;
export const MAX_SPEECH_CHARS = 500;
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
let busy = false;

export class SpeechError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function pocketEndpoint(): string {
  const value = process.env.JOY_POCKET_TTS_URL;
  if (!value) throw new SpeechError(503, 'Pocket TTS is not configured. Set JOY_POCKET_TTS_URL on this machine’s daemon.');
  let url: URL;
  try { url = new URL(value); } catch { throw new SpeechError(503, 'Invalid JOY_POCKET_TTS_URL.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !['/', '/tts'].includes(url.pathname)) {
    throw new SpeechError(503, 'JOY_POCKET_TTS_URL must be an HTTP loopback URL (127.0.0.1 or [::1]), with an optional /tts path.');
  }
  url.pathname = '/tts';
  return url.href;
}

/** Pocket's unseekable response advertises a billion frames. Repair the
 * lengths of its PCM WAV after buffering so native players see a finite clip. */
export function finishPocketWav(wav: Buffer): Buffer {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new SpeechError(502, 'Pocket TTS returned invalid WAV audio.');
  }
  let format = false;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const kind = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (kind === 'fmt ' && size >= 16 && offset + 8 + size <= wav.length) {
      format = wav.readUInt16LE(offset + 8) === 1 && wav.readUInt16LE(offset + 10) === 1 && wav.readUInt16LE(offset + 22) === 16;
    }
    if (kind === 'data') {
      const actual = wav.length - offset - 8;
      if (!format || actual === 0 || actual % 2 !== 0) break;
      wav.writeUInt32LE(wav.length - 8, 4);
      wav.writeUInt32LE(actual, offset + 4);
      return wav;
    }
    offset += 8 + size + (size % 2);
  }
  throw new SpeechError(502, 'Pocket TTS returned unsupported or empty PCM audio.');
}

export async function synthesizeSpeech(body: Record<string, unknown>, signal?: AbortSignal): Promise<Buffer> {
  if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > MAX_SPEECH_CHARS) {
    throw new SpeechError(400, `Speech text must contain 1–${MAX_SPEECH_CHARS} characters.`);
  }
  if (typeof body.voice !== 'string' || !(POCKET_VOICES as readonly string[]).includes(body.voice)) {
    throw new SpeechError(400, 'Choose a built-in Pocket TTS voice.');
  }
  const endpoint = pocketEndpoint();
  if (busy) throw new SpeechError(429, 'Pocket TTS is busy. Try again shortly.');
  busy = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const form = new FormData();
    form.set('text', body.text.trim());
    form.set('voice_url', body.voice);
    const response = await fetch(endpoint, { method: 'POST', body: form, signal: controller.signal, redirect: 'error' });
    if (!response.ok || !response.headers.get('content-type')?.includes('audio/wav') || !response.body) {
      throw new SpeechError(502, `Pocket TTS could not generate audio (HTTP ${response.status}).`);
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > MAX_AUDIO_BYTES) throw new SpeechError(502, 'Pocket TTS audio exceeded the clip size limit.');
      chunks.push(Buffer.from(chunk));
    }
    return finishPocketWav(Buffer.concat(chunks));
  } catch (error) {
    if (error instanceof SpeechError) throw error;
    throw new SpeechError(503, controller.signal.aborted ? 'Pocket TTS request cancelled or timed out.' : 'Pocket TTS is unavailable. Check that it is running on this machine.');
  } finally {
    controller.abort();
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    busy = false;
  }
}
