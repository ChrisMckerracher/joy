import { beforeEach, expect, test, vi } from 'vitest';
import type { Message } from '@/sync/typesMessage';
const mocks = vi.hoisted(() => ({
    speak: vi.fn(), end: vi.fn(), connected: true,
    state: { sessions: { s: { thinking: false } }, sessionMessages: { s: { messages: [] as Message[] } } },
}));
vi.mock('../RealtimeSession', () => ({
    endVoice: mocks.end, getCurrentRealtimeSessionId: () => 's',
    isVoiceConnected: () => mocks.connected, speakSessionUpdate: mocks.speak,
}));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => mocks.state } }));
vi.mock('@/text', () => ({ t: (key: string, args: unknown) => `${key} ${JSON.stringify(args ?? '')}` }));
import { voiceHooks } from './voiceHooks';
const reply = (id: string, text: string, extra = {}): Message => ({ kind: 'agent-text', id, text, createdAt: Date.now(), localId: null, ...extra });
beforeEach(() => {
    mocks.speak.mockClear(); mocks.end.mockClear(); mocks.connected = true;
    mocks.state.sessions.s.thinking = false; mocks.state.sessionMessages.s.messages = [];
    voiceHooks.onVoiceStarted('s');
});
test('reads finished replies once, ignores streaming deltas and reasoning', () => {
    const m = reply('r', 'Complete.'); mocks.state.sessionMessages.s.messages = [reply('thought', 'secret', { isThinking: true }), m];
    voiceHooks.onMessages('s', [m]); expect(mocks.speak).not.toHaveBeenCalled();
    voiceHooks.onReady('s'); voiceHooks.onReady('s');
    expect(mocks.speak).toHaveBeenCalledTimes(1);
    expect(mocks.speak.mock.calls[0][1].text).toBe('Complete.');
});
test('only the armed session speaks and navigating away stops it', () => {
    mocks.state.sessionMessages.s.messages = [reply('r', 'Complete.')];
    voiceHooks.onReady('other'); expect(mocks.speak).not.toHaveBeenCalled();
    voiceHooks.onSessionFocus('other'); expect(mocks.end).toHaveBeenCalledOnce();
});
test('does not repeat preexisting replies or old questions loaded later', () => {
    mocks.state.sessionMessages.s.messages = [reply('r', 'Old reply')]; voiceHooks.onVoiceStarted('s');
    voiceHooks.onReady('s');
    voiceHooks.onMessages('s', [reply('old', '<joy-options><joy-option>A</joy-option></joy-options>', { createdAt: 1 })]);
    expect(mocks.speak).not.toHaveBeenCalled();
});
test('reads a question once and keeps choices; onReady does not repeat it', () => {
    const m = reply('q', 'Choose <joy-options><joy-option>A</joy-option><joy-option>B</joy-option></joy-options>');
    mocks.state.sessionMessages.s.messages = [m];
    voiceHooks.onMessages('s', [m]); voiceHooks.onMessages('s', [m]); voiceHooks.onReady('s');
    expect(mocks.speak).toHaveBeenCalledTimes(1); expect(mocks.speak.mock.calls[0][1].text).toContain('Choose A B');
});
test('pending approval excludes arguments and becomes invalid after answering', () => {
    const m = { kind: 'tool-call', id: 't', tool: { name: 'Bash', input: 'SECRET COMMAND', permission: { id: 'p', status: 'pending' } } } as Message;
    mocks.state.sessionMessages.s.messages = [m]; voiceHooks.onMessages('s', [m]); voiceHooks.onMessages('s', [m]);
    expect(mocks.speak).toHaveBeenCalledTimes(1);
    const item = mocks.speak.mock.calls[0][1]; expect(item.text).not.toContain('SECRET'); expect(item.valid()).toBe(true);
    if (m.kind === 'tool-call') m.tool.permission!.status = 'approved';
    expect(item.valid()).toBe(false);
});
