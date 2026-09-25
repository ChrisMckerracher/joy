// Pocket TTS reads notifications; it never records audio or executes commands.
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { tunnelFetch } from '@/sync/v2/tunnel';
import { Modal } from '@/modal';
import { t } from '@/text';
import { voiceHooks } from './hooks/voiceHooks';
import { createSpeechOutput } from './speechOutput';
import { SpeechQueue, type SpeechItem } from './speechQueue';

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
    // Unlock browser audio directly in the user gesture, before network awaits.
    const ctx = sync.machineCtx(sessionId);
    if (!ctx) { Modal.alert(t('common.error'), t('pocketVoice.noMachine')); return false; }
    const output = createSpeechOutput();
    const voice = storage.getState().settings.pocketTtsVoice;
    currentSessionId = sessionId;
    const state = storage.getState();
    state.setVoiceArmedSessionId(sessionId);
    state.setRealtimeStatus('connecting');
    const ownQueue = new SpeechQueue(async (text, signal) => {
        const response = await tunnelFetch({
            ...ctx, method: 'POST', path: '/v2/voice/speech', signal,
            headers: { 'content-type': 'application/json' },
            body: new TextEncoder().encode(JSON.stringify({ text, voice })),
        });
        if (response.status !== 200) {
            let message = t('pocketVoice.unavailable');
            try { message = JSON.parse(new TextDecoder().decode(response.body)).error || message; } catch { /* older daemon */ }
            throw new Error(message);
        }
        return response.body;
    }, output, speaking => {
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
