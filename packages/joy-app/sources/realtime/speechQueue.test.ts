import { expect, test, vi, afterEach } from 'vitest';
import { SpeechQueue } from './speechQueue';
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; }
afterEach(() => vi.useRealTimers());
function setup(generateImpl: (text: string, signal: AbortSignal) => Promise<Uint8Array> = async () => new Uint8Array([1])) {
    const generate = vi.fn(generateImpl);
    const output = { prepare: vi.fn(async () => {}), play: vi.fn(async () => {}), dispose: vi.fn() };
    const failed = vi.fn(); const mode = vi.fn();
    const queue = new SpeechQueue(generate, output, mode, failed);
    return { queue, output, generate, failed, mode };
}
test('serializes audio; a stopped request cannot play after it resolves', async () => {
    const pending = deferred<Uint8Array>();
    const { queue, output, generate } = setup(vi.fn(() => pending.promise));
    queue.push({ key: '1', text: 'first' }); queue.push({ key: '2', text: 'second' });
    expect(generate).toHaveBeenCalledTimes(1);
    const signal = generate.mock.calls[0][1];
    queue.stop(); expect(signal.aborted).toBe(true);
    pending.resolve(new Uint8Array([1])); await tick();
    expect(output.play).not.toHaveBeenCalled(); expect(output.dispose).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledTimes(1);
});
test('waits for playback before generating next clip', async () => {
    const { queue, output, generate, mode } = setup();
    const playing = deferred<void>(); output.play.mockReturnValueOnce(playing.promise);
    queue.push({ key: '1', text: 'first' }); queue.push({ key: '2', text: 'second' }); await tick();
    expect(generate).toHaveBeenCalledTimes(1); expect(mode).toHaveBeenLastCalledWith(true);
    playing.resolve(); await tick(); expect(generate).toHaveBeenCalledTimes(2);
    expect(mode).toHaveBeenLastCalledWith(false);
});
test('rechecks answered approvals after synthesis', async () => {
    const pending = deferred<Uint8Array>(); const { queue, output } = setup(vi.fn(() => pending.promise));
    let valid = true; queue.push({ key: 'approval', text: 'Approve?', valid: () => valid });
    valid = false; pending.resolve(new Uint8Array([1])); await tick(); expect(output.play).not.toHaveBeenCalled();
});
test('bounds, coalesces and expires queued work', async () => {
    vi.useFakeTimers(); const pending = deferred<Uint8Array>();
    const { queue, generate, output } = setup(vi.fn(() => pending.promise));
    queue.push({ key: 'first', text: 'first' });
    for (let i = 0; i < 100; i++) queue.push({ key: String(i), text: 'queued' });
    await vi.advanceTimersByTimeAsync(31_000);
    pending.resolve(new Uint8Array([1])); await tick();
    expect(generate).toHaveBeenCalledTimes(1); expect(output.play).not.toHaveBeenCalled();
});
test('coalesces repeated queued summaries and caps their text', async () => {
    const pending = deferred<Uint8Array>();
    const { queue, generate } = setup(vi.fn(async () => pending.promise));
    queue.push({ key: 'busy', text: 'busy' });
    queue.push({ key: 'ready', text: 'old' }); queue.push({ key: 'ready', text: 'x'.repeat(900) });
    pending.resolve(new Uint8Array([1])); await tick();
    expect(generate.mock.calls.map(call => call[0])).toEqual(['busy', 'x'.repeat(500)]);
});
test('fails once and clears pending work after provider failure', async () => {
    const { queue, failed, output, generate } = setup(vi.fn(async () => { throw new Error('offline'); }));
    queue.push({ key: '1', text: 'first' }); queue.push({ key: '2', text: 'second' }); await tick();
    expect(failed).toHaveBeenCalledOnce(); expect(output.dispose).toHaveBeenCalledOnce(); expect(generate).toHaveBeenCalledOnce();
});
