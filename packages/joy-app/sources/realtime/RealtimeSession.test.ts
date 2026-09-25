import { beforeEach, expect, test, vi } from 'vitest';
const m = vi.hoisted(() => ({
    fetch: vi.fn(), alert: vi.fn(), started: vi.fn(),
    output: { prepare: vi.fn(async () => {}), play: vi.fn(async () => {}), dispose: vi.fn() },
    state: { settings: { pocketTtsVoice: 'alba' }, realtimeStatus: 'disconnected', voiceArmedSessionId: null as string | null,
        setRealtimeStatus: vi.fn(), setVoiceArmedSessionId: vi.fn(), setRealtimeMode: vi.fn(), clearRealtimeModeDebounce: vi.fn() },
}));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => m.state } }));
vi.mock('@/sync/sync', () => ({ sync: { machineCtx: () => ({ machineId: 'machine', machineKey: new Uint8Array(32), relayUrl: 'https://relay', accountToken: 'secret', localSessionId: 'local' }) } }));
vi.mock('@/sync/v2/tunnel', () => ({ tunnelFetch: m.fetch }));
vi.mock('@/modal', () => ({ Modal: { alert: m.alert } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('./speechOutput', () => ({ createSpeechOutput: () => m.output }));
vi.mock('./hooks/voiceHooks', () => ({ voiceHooks: { onVoiceStarted: m.started } }));
import { startVoice, endVoice } from './RealtimeSession';
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
beforeEach(async () => {
    await endVoice(); vi.clearAllMocks();
    m.output.prepare.mockResolvedValue(); m.output.play.mockResolvedValue();
    m.fetch.mockResolvedValue({ status: 200, body: new Uint8Array([1]) });
    m.state.setRealtimeStatus.mockImplementation(value => { m.state.realtimeStatus = value; });
    m.state.setVoiceArmedSessionId.mockImplementation(value => { m.state.voiceArmedSessionId = value; });
});
test('sends only speech and built-in voice over the selected machine tunnel', async () => {
    expect(await startVoice('s')).toBe(true); await tick();
    const request = m.fetch.mock.calls[0][0];
    expect(request.machineId).toBe('machine'); expect(request.path).toBe('/v2/voice/speech');
    expect(JSON.parse(new TextDecoder().decode(request.body))).toEqual({ text: 'pocketVoice.welcome', voice: 'alba' });
    await endVoice(); expect(request.signal.aborted).toBe(true);
});
test('closing during synthesis suppresses late playback', async () => {
    let resolve!: (v: unknown) => void;
    m.fetch.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    await startVoice('s'); await endVoice(); resolve({ status: 200, body: new Uint8Array([1]) }); await tick();
    expect(m.output.play).not.toHaveBeenCalled(); expect(m.state.realtimeStatus).toBe('disconnected');
});
test('closing during audio initialization suppresses welcome and connection', async () => {
    let resolve!: () => void; m.output.prepare.mockReturnValueOnce(new Promise<void>(r => { resolve = r; }));
    const start = startVoice('s'); await endVoice(); resolve(); expect(await start).toBe(false);
    expect(m.fetch).not.toHaveBeenCalled(); expect(m.state.realtimeStatus).toBe('disconnected');
});
test('shows daemon setup errors and parks until explicitly retried', async () => {
    m.fetch.mockResolvedValueOnce({ status: 503, body: new TextEncoder().encode(JSON.stringify({ error: 'Configure Pocket TTS' })) });
    await startVoice('s'); await tick();
    expect(m.state.realtimeStatus).toBe('error'); expect(m.alert).toHaveBeenCalledWith('pocketVoice.failed', 'Configure Pocket TTS');
    expect(m.fetch).toHaveBeenCalledOnce();
});
