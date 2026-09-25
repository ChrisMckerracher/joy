import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import { randomUUID } from 'expo-crypto';
import type { SpeechOutput } from './speechQueue';

export function createSpeechOutput(): SpeechOutput {
    let disposed = false;
    let cancel: (() => void) | null = null;
    return {
        async prepare() {
            await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false, shouldPlayInBackground: false });
        },
        async play(wav, signal) {
            if (disposed || signal.aborted) return;
            const file = new File(Paths.cache, `joy-speech-${randomUUID()}.wav`);
            try {
                file.write(wav);
                const player = createAudioPlayer(file.uri);
                try {
                    await new Promise<void>((resolve, reject) => {
                        let settled = false;
                        const finish = (error?: Error) => {
                            if (settled) return;
                            settled = true;
                            clearTimeout(timeout);
                            sub.remove();
                            signal.removeEventListener('abort', abort);
                            cancel = null;
                            error ? reject(error) : resolve();
                        };
                        const abort = () => finish();
                        const timeout = setTimeout(() => finish(new Error('Speech playback timed out.')), 90_000);
                        const sub = player.addListener('playbackStatusUpdate', status => {
                            if (status.didJustFinish) finish();
                            else if (status.playbackState === 'error') finish(new Error('Could not play speech audio.'));
                        });
                        cancel = abort;
                        signal.addEventListener('abort', abort, { once: true });
                        try { player.play(); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
                    });
                } finally { player.remove(); }
            } finally { if (file.exists) file.delete(); }
        },
        dispose() { disposed = true; cancel?.(); },
    };
}
