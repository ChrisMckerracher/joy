import { afterEach, expect, test, vi } from 'vitest';
import { createSpeechOutput } from './speechOutput.web';

afterEach(() => vi.unstubAllGlobals());
async function fixture() {
    const sources: any[] = [];
    const ctx = {
        currentTime: 10, state: 'running', destination: {}, resume: vi.fn(async () => {}), close: vi.fn(async () => {}),
        createBuffer: (_: number, length: number, rate: number) => ({ duration: length / rate, getChannelData: () => new Float32Array(length) }),
        createBufferSource: () => {
            const source = { connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null as (() => void) | null };
            sources.push(source); return source;
        },
    };
    vi.stubGlobal('AudioContext', vi.fn(function () { return ctx; }));
    const output = createSpeechOutput(); await output.prepare();
    const controller = new AbortController(); const started = vi.fn();
    const stream = output.stream!(controller.signal, started);
    return { output, stream, sources, ctx, controller, started };
}
test('plays PCM before finish and schedules adjacent chunks without gaps', async () => {
    const { stream, sources, ctx, started } = await fixture();
    stream.push(new Float32Array(24000), 24000);
    ctx.currentTime = 10.5;
    stream.push(new Float32Array(12000), 24000);
    expect(sources[0].start).toHaveBeenCalledWith(10.04);
    expect(sources[1].start).toHaveBeenCalledWith(11.04);
    expect(started).toHaveBeenCalledOnce();
    const finished = vi.fn(); const done = stream.finish().then(finished);
    sources[0].onended(); await Promise.resolve(); expect(finished).not.toHaveBeenCalled();
    sources[1].onended(); await done; expect(finished).toHaveBeenCalledOnce();
    expect(sources.every(s => s.disconnect.mock.calls.length === 1)).toBe(true);
});
test.each(['abort', 'dispose', 'cancel'] as const)('%s stops scheduled audio and resolves playback', async reason => {
    const { output, stream, sources, controller } = await fixture();
    stream.push(new Float32Array(24000), 24000);
    const done = stream.finish();
    if (reason === 'abort') controller.abort();
    else if (reason === 'dispose') output.dispose();
    else stream.cancel();
    await done;
    expect(sources[0].stop).toHaveBeenCalledOnce();
    expect(sources[0].disconnect).toHaveBeenCalledOnce();
    stream.push(new Float32Array(24000), 24000);
    expect(sources).toHaveLength(1);
});
test('does not schedule audio when already stopped', async () => {
    const { stream, sources, controller } = await fixture();
    controller.abort(); stream.push(new Float32Array(24000), 24000); await stream.finish();
    expect(sources).toHaveLength(0);
});
