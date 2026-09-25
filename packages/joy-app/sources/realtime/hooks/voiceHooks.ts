import { endVoice, getCurrentRealtimeSessionId, isVoiceConnected, speakSessionUpdate } from '../RealtimeSession';
import { storage } from '@/sync/storage';
import type { Message } from '@/sync/typesMessage';
import { speechText } from '../speechText';
import { t } from '@/text';

let seen = new Set<string>();
let lastReply: string | null = null;
let startedAt = 0;
function remember(key: string) {
    seen.add(key);
    if (seen.size > 500) seen.delete(seen.values().next().value!);
}
function active(sessionId: string) { return isVoiceConnected() && sessionId === getCurrentRealtimeSessionId(); }
function messages(sessionId: string) { return storage.getState().sessionMessages[sessionId]?.messages ?? []; }
function pending(sessionId: string, requestId: string) {
    return messages(sessionId).some(m => m.kind === 'tool-call' && m.tool.permission?.id === requestId && m.tool.permission.status === 'pending');
}
export const voiceHooks = {
    onVoiceStarted(sessionId: string) {
        // Do not read historical questions when a page of old messages loads.
        seen = new Set(messages(sessionId).filter(m => m.kind === 'agent-text').map(m => m.id));
        startedAt = Date.now();
        const latest = messages(sessionId).find(m => m.kind === 'agent-text' && !m.isThinking);
        lastReply = !storage.getState().sessions[sessionId]?.thinking && latest?.kind === 'agent-text' ? latest.id + latest.text : null;
    },
    onSessionFocus(sessionId: string) {
        // An armed session is explicit: navigating away cancels its audio,
        // including a generation in flight on the previous machine.
        const current = getCurrentRealtimeSessionId();
        if (current && current !== sessionId) void endVoice();
    },
    onMessages(sessionId: string, changed: Message[]) {
        if (!active(sessionId)) return;
        for (const m of changed) {
            if (m.kind === 'tool-call' && m.tool.permission?.status === 'pending') {
                const requestId = m.tool.permission.id;
                if (seen.has(requestId)) continue;
                remember(requestId);
                speakSessionUpdate(sessionId, {
                    key: requestId,
                    text: t('pocketVoice.approval', { tool: speechText(m.tool.name, 80) }),
                    valid: () => pending(sessionId, requestId),
                });
            }
            if (m.kind === 'agent-text' && !m.isThinking && !seen.has(m.id) && m.createdAt >= startedAt && /<joy-options>[\s\S]*<\/joy-options>/.test(m.text)) {
                remember(m.id);
                lastReply = m.id + m.text;
                speakSessionUpdate(sessionId, { key: m.id, text: speechText(m.text) + ' ' + t('pocketVoice.answerInApp') });
            }
        }
    },
    onReady(sessionId: string) {
        if (!active(sessionId)) return;
        // Store order is newest first. Read a finished reply, never incremental
        // assistant deltas, which otherwise repeat fragments on every update.
        const latest = messages(sessionId).find(m => m.kind === 'agent-text' && !m.isThinking);
        if (latest?.kind === 'agent-text' && latest.id + latest.text !== lastReply) {
            lastReply = latest.id + latest.text;
            remember(latest.id);
            const text = speechText(latest.text);
            speakSessionUpdate(sessionId, { key: 'ready', text: text || t('pocketVoice.ready') });
        }
    },
};
