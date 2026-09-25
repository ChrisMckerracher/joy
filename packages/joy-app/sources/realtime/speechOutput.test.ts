import { beforeEach, expect, test, vi } from 'vitest';
const m = vi.hoisted(() => ({ remove: vi.fn(), play: vi.fn(), write: vi.fn(), deleted: vi.fn(), mode: vi.fn(), listener: null as null | ((status: { didJustFinish: boolean }) => void) }));
vi.mock('expo-audio', () => ({
    setAudioModeAsync: m.mode,
    createAudioPlayer: () => ({ remove: m.remove, play: m.play, addListener: (_event: string, fn: typeof m.listener) => { m.listener = fn; return { remove: vi.fn() }; } }),
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test' }));
vi.mock('expo-file-system', () => ({ Paths: { cache: '/tmp' }, File: class { exists = true; uri = 'cache.wav'; write = m.write; delete = m.deleted; } }));
import { createSpeechOutput } from './speechOutput';
beforeEach(() => vi.clearAllMocks());
test('native playback deletes its temporary audio on completion', async () => {
    const output = createSpeechOutput(); await output.prepare();
    expect(m.mode).toHaveBeenCalledWith(expect.objectContaining({ allowsRecording: false }));
    const playing = output.play(new Uint8Array([1]), new AbortController().signal);
    expect(m.play).toHaveBeenCalledOnce(); m.listener!({ didJustFinish: true }); await playing;
    expect(m.remove).toHaveBeenCalledOnce(); expect(m.deleted).toHaveBeenCalledOnce();
});
test('native cancellation releases player and file without waiting for completion', async () => {
    const output = createSpeechOutput(); const controller = new AbortController();
    const playing = output.play(new Uint8Array([1]), controller.signal); controller.abort(); output.dispose(); await playing;
    expect(m.remove).toHaveBeenCalledOnce(); expect(m.deleted).toHaveBeenCalledOnce();
});
