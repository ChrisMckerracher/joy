import type { SpeechOutput } from './speechQueue';

export function createSpeechOutput(): SpeechOutput {
    let context: AudioContext | null = null;
    let disposed = false;
    return {
        // Called directly from the speaker tap, before a network await. This
        // unlocks playback in browsers that require user activation.
        async prepare() {
            context = new AudioContext();
            await context.resume();
            if (context.state !== 'running') throw new Error('Audio playback is blocked. Tap the speaker to try again.');
        },
        async play(wav, signal) {
            const ctx = context;
            if (!ctx || disposed || signal.aborted) return;
            const buffer = await ctx.decodeAudioData(wav.slice().buffer as ArrayBuffer);
            if (disposed || signal.aborted) return;
            await new Promise<void>((resolve, reject) => {
                const source = ctx.createBufferSource();
                source.buffer = buffer;
                source.connect(ctx.destination);
                const done = () => { signal.removeEventListener('abort', abort); source.disconnect(); resolve(); };
                const abort = () => { source.stop(); done(); };
                source.onended = done;
                signal.addEventListener('abort', abort, { once: true });
                try { source.start(); } catch (error) { signal.removeEventListener('abort', abort); source.disconnect(); reject(error); }
            });
        },
        dispose() {
            disposed = true;
            if (context) void context.close().catch(() => {});
            context = null;
        },
    };
}
