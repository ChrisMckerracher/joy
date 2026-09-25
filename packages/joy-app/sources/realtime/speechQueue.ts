/** A bounded, expiring speech queue. Stopping retires both generated audio
 * and playback, even if a transport ignores cancellation and resolves late. */
export interface SpeechItem { key: string; text: string; valid?: () => boolean }
export interface SpeechOutput {
    prepare(): Promise<void>;
    play(wav: Uint8Array, signal: AbortSignal): Promise<void>;
    dispose(): void;
}
export class SpeechQueue {
    private pending: Array<SpeechItem & { at: number }> = [];
    private controller = new AbortController();
    private running = false;
    constructor(
        private generate: (text: string, signal: AbortSignal) => Promise<Uint8Array>,
        private output: SpeechOutput,
        private mode: (speaking: boolean) => void,
        private failed: (error: unknown) => void,
    ) {}
    push(item: SpeechItem) {
        if (this.controller.signal.aborted || !item.text.trim()) return;
        this.pending = this.pending.filter(p => p.key !== item.key);
        if (this.pending.length >= 8) this.pending.shift();
        this.pending.push({ ...item, text: item.text.slice(0, 500), at: Date.now() });
        void this.drain();
    }
    stop() {
        this.controller.abort();
        this.pending = [];
        this.output.dispose();
    }
    private async drain() {
        if (this.running) return;
        this.running = true;
        const signal = this.controller.signal;
        try {
            while (this.pending.length && !signal.aborted) {
                const item = this.pending.shift()!;
                if (Date.now() - item.at > 30_000 || item.valid?.() === false) continue;
                const wav = await this.generate(item.text, signal);
                if (signal.aborted) return;
                if (Date.now() - item.at > 30_000 || item.valid?.() === false) continue;
                this.mode(true);
                await this.output.play(wav, signal);
                if (!signal.aborted) this.mode(false);
            }
        } catch (error) {
            if (!signal.aborted) { this.stop(); this.failed(error); }
        } finally { this.running = false; }
    }
}
