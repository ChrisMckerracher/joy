import type { SpeechOutput, SpeechStream } from './speechQueue';

export function createSpeechOutput(): SpeechOutput {
    let context: AudioContext | null = null;
    let disposed = false;
    const active = new Set<() => void>();
    function stream(signal: AbortSignal, onStart: () => void): SpeechStream {
        const ctx = context;
        const sources = new Set<AudioBufferSourceNode>();
        let nextStart = 0;
        let started = false;
        let closed = disposed || signal.aborted || !ctx;
        let finishing = false;
        let complete: (() => void) | undefined;
        const cleanup = () => { signal.removeEventListener('abort', cancel); active.delete(cancel); };
        const cancel = () => {
            closed = true;
            for (const source of sources) {
                source.onended = null;
                try { source.stop(); } catch { /* Already ended. */ }
                source.disconnect();
            }
            sources.clear(); cleanup(); complete?.();
        };
        if (!closed) { active.add(cancel); signal.addEventListener('abort', cancel, { once: true }); }
        return {
            push(pcm, sampleRate) {
                if (closed || finishing || !ctx || !pcm.length) return;
                const buffer = ctx.createBuffer(1, pcm.length, sampleRate);
                buffer.getChannelData(0).set(pcm);
                const source = ctx.createBufferSource();
                source.buffer = buffer;
                source.connect(ctx.destination);
                sources.add(source);
                source.onended = () => {
                    source.disconnect(); sources.delete(source);
                    if (finishing && !sources.size) { closed = true; cleanup(); complete?.(); }
                };
                // Schedule PCM on the audio clock so adjacent chunks meet exactly.
                // A short lead gives the audio thread time to consume the buffer.
                const at = Math.max(nextStart, ctx.currentTime + 0.04);
                try { source.start(at); }
                catch (error) { cancel(); throw error; }
                nextStart = at + buffer.duration;
                if (!started) { started = true; onStart(); }
            },
            finish() {
                finishing = true;
                if (closed || !sources.size) { closed = true; cleanup(); return Promise.resolve(); }
                return new Promise<void>(resolve => { complete = resolve; });
            },
            cancel,
        };
    }
    return {
        // Unlock playback directly from the speaker tap, before network awaits.
        async prepare() {
            context = new AudioContext();
            await context.resume();
            if (context.state !== 'running') throw new Error('Audio playback is blocked. Tap the speaker to try again.');
        },
        stream,
        async play(wav, signal) {
            const ctx = context;
            if (!ctx || disposed || signal.aborted) return;
            const buffer = await ctx.decodeAudioData(wav.slice().buffer as ArrayBuffer);
            const playback = stream(signal, () => {});
            playback.push(buffer.getChannelData(0), buffer.sampleRate);
            await playback.finish();
        },
        dispose() {
            disposed = true;
            for (const cancel of active) cancel();
            if (context) void context.close().catch(() => {});
            context = null;
        },
    };
}
