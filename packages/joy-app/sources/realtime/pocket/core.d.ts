export type Progress = (file: string, loaded: number, total: number) => void;
export const supportedVoices: string[];
export function checkAborted(signal: AbortSignal): void;
export function pcmToWav(chunks: Float32Array[], sampleRate?: number): Uint8Array;
export class PocketEngine {
    constructor(ort: object, bundle: object, load: (file: string, signal: AbortSignal, progress: Progress) => Promise<Uint8Array | string>, sessionOptions: object);
    prepare(voice: string, signal: AbortSignal, progress: Progress): Promise<void>;
    generate(text: string, signal: AbortSignal): Promise<Uint8Array>;
    dispose(): Promise<void>;
}
