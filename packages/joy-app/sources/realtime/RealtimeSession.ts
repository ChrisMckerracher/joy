// Pocket TTS reads notifications; it never records audio or executes commands.
import { storage } from '@/sync/storage';
import { Modal } from '@/modal';
import { t } from '@/text';
import { voiceHooks } from './hooks/voiceHooks';
import { createSpeechOutput } from './speechOutput';
import { SpeechQueue, type SpeechItem } from './speechQueue';
import { createPocketSpeech } from './pocket/speech';
import { resetPocketProgress } from './pocket/progress';

let queue: SpeechQueue | null = null;
let currentSessionId: string | null = null;

export function getCurrentRealtimeSessionId() { return currentSessionId; }
export function isVoiceConnected() { return storage.getState().realtimeStatus === 'connected'; }
export function isVoiceArmed() { return storage.getState().voiceArmedSessionId !== null; }
export function speakSessionUpdate(sessionId: string, item: SpeechItem) {
    if (sessionId === currentSessionId && isVoiceConnected()) queue?.push(item);
}

export async function startVoice(sessionId: string): Promise<boolean> {
    if (queue && currentSessionId === sessionId) return true;
    endVoice();
    // Unlock browser audio directly in the user gesture, before model loading.
    const output = createSpeechOutput();
    const speech = createPocketSpeech();
    const voice = storage.getState().settings.pocketTtsVoice;
    resetPocketProgress(voice);
    currentSessionId = sessionId;
    const state = storage.getState();
    state.setVoiceArmedSessionId(sessionId);
    state.setRealtimeStatus('connecting');
    const ownQueue = new SpeechQueue((text, signal) => speech.generate(text, signal), {
        prepare: () => output.prepare(),
        play: (wav, signal) => output.play(wav, signal),
        dispose: () => { output.dispose(); speech.dispose(); },
    }, speaking => {
        if (queue === ownQueue) storage.getState().setRealtimeMode(speaking ? 'agent-speaking' : 'idle', true);
    }, error => {
        if (queue !== ownQueue) return;
        queue = null;
        storage.getState().setRealtimeMode('idle', true);
        storage.getState().setRealtimeStatus('error');
        Modal.alert(t('pocketVoice.failed'), error instanceof Error ? error.message : t('pocketVoice.unavailable'));
    });
    queue = ownQueue;
    try {
        await output.prepare();
        if (queue !== ownQueue) return false;
        await speech.prepare(voice);
        if (queue !== ownQueue) return false;
        voiceHooks.onVoiceStarted(sessionId);
        state.setRealtimeStatus('connected');
        ownQueue.push({ key: 'welcome', text: t('pocketVoice.welcome') });
        return true;
    } catch (error) {
        if (queue === ownQueue) {
            endVoice();
            Modal.alert(t('pocketVoice.failed'), error instanceof Error ? error.message : String(error));
        }
        return false;
    }
}

export function endVoice(): void {
    const old = queue;
    queue = null;
    old?.stop();
    currentSessionId = null;
    const state = storage.getState();
    state.clearRealtimeModeDebounce();
    state.setRealtimeMode('idle', true);
    state.setRealtimeStatus('disconnected');
    state.setVoiceArmedSessionId(null);
}
