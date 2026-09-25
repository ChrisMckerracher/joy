import { beforeEach, expect, test, vi } from 'vitest';
const m = vi.hoisted(() => ({
    generate: vi.fn(), prepare: vi.fn(async (_voice: string) => {}), dispose: vi.fn(), alert: vi.fn(), started: vi.fn(),
    output: { prepare: vi.fn(async () => {}), play: vi.fn(async () => {}), dispose: vi.fn(), stream: vi.fn() },
    state: { settings: { pocketTtsVoice: 'alba' }, realtimeStatus: 'disconnected', voiceArmedSessionId: null as string | null,
        setRealtimeStatus: vi.fn(), setVoiceArmedSessionId: vi.fn(), setRealtimeMode: vi.fn(), clearRealtimeModeDebounce: vi.fn() },
}));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => m.state } }));
vi.mock('./pocket/speech', () => ({ createPocketSpeech: () => ({ prepare: m.prepare, generate: m.generate, dispose: m.dispose }) }));
vi.mock('./pocket/progress', () => ({ resetPocketProgress: vi.fn() }));
vi.mock('@/modal', () => ({ Modal: { alert: m.alert } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('./speechOutput', () => ({ createSpeechOutput: () => m.output }));
vi.mock('./hooks/voiceHooks', () => ({ voiceHooks: { onVoiceStarted: m.started } }));
import { startVoice, endVoice } from './RealtimeSession';
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
beforeEach(async () => {
    await endVoice(); vi.clearAllMocks();
    m.output.prepare.mockResolvedValue(); m.output.play.mockResolvedValue();
    m.generate.mockResolvedValue(new Uint8Array([1])); m.prepare.mockResolvedValue();
    m.state.setRealtimeStatus.mockImplementation(value => { m.state.realtimeStatus = value; });
    m.state.setVoiceArmedSessionId.mockImplementation(value => { m.state.voiceArmedSessionId = value; });
});
test('loads the voice and synthesizes on the client without a machine connection', async () => {
    expect(await startVoice('s')).toBe(true); await tick();
    expect(m.prepare).toHaveBeenCalledWith('alba');
    expect(m.generate).toHaveBeenCalledWith('pocketVoice.welcome', expect.any(AbortSignal));
    const signal = m.generate.mock.calls[0][1];
    endVoice(); expect(signal.aborted).toBe(true); expect(m.dispose).toHaveBeenCalled();
});
test('closing during synthesis suppresses late playback', async () => {
    let resolve!: (v: unknown) => void;
    m.generate.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    await startVoice('s'); await endVoice(); resolve(new Uint8Array([1])); await tick();
    expect(m.output.play).not.toHaveBeenCalled(); expect(m.state.realtimeStatus).toBe('disconnected');
});
test('waits for a complete clip even when the output supports incremental playback', async () => {
    let resolve!: (v: Uint8Array) => void;
    m.generate.mockReturnValueOnce(new Promise<Uint8Array>(r => { resolve = r; }));
    await startVoice('s'); await tick();
    expect(m.output.stream).not.toHaveBeenCalled();
    expect(m.output.play).not.toHaveBeenCalled();
    expect(m.generate.mock.calls[0]).toHaveLength(2);
    const wav = new Uint8Array([1, 2, 3]); resolve(wav); await tick();
    expect(m.output.play).toHaveBeenCalledWith(wav, expect.any(AbortSignal));
});
test('closing during audio initialization suppresses welcome and connection', async () => {
    let resolve!: () => void; m.output.prepare.mockReturnValueOnce(new Promise<void>(r => { resolve = r; }));
    const start = startVoice('s'); await endVoice(); resolve(); expect(await start).toBe(false);
    expect(m.generate).not.toHaveBeenCalled(); expect(m.state.realtimeStatus).toBe('disconnected');
});
test('shows local inference errors and parks until explicitly retried', async () => {
    m.generate.mockRejectedValueOnce(new Error('Unsupported operator'));
    await startVoice('s'); await tick();
    expect(m.state.realtimeStatus).toBe('error'); expect(m.alert).toHaveBeenCalledWith('pocketVoice.failed', 'Unsupported operator');
    expect(m.generate).toHaveBeenCalledOnce();
});

test('closing during model load disposes the engine and suppresses late errors', async () => {
    let reject!: (error: Error) => void;
    m.prepare.mockReturnValueOnce(new Promise<void>((_, r) => { reject = r; }));
    const start = startVoice('s'); await tick(); endVoice(); reject(new Error('cancelled'));
    expect(await start).toBe(false); expect(m.dispose).toHaveBeenCalled();
    expect(m.generate).not.toHaveBeenCalled(); expect(m.alert).not.toHaveBeenCalled();
});
test('model initialization failure releases audio and the engine', async () => {
    m.prepare.mockRejectedValueOnce(new Error('Download failed'));
    expect(await startVoice('s')).toBe(false);
    expect(m.output.dispose).toHaveBeenCalled(); expect(m.dispose).toHaveBeenCalled();
    expect(m.alert).toHaveBeenCalledWith('pocketVoice.failed', 'Download failed');
});
