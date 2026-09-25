import { describe, expect, it } from 'vitest';
import { buildListLayout, partitionForList, pinnedDotColour, pinnedStateRank, stateUrgency, type ListSession } from './sessionListModel';
import { STATUS_PALETTE } from '@/utils/statusPalette';
import type { SessionState } from '@/sync/sessionFacts';

const NOW = 1_800_000_000_000;

const s = (over: Partial<ListSession> & Pick<ListSession, 'id'>): ListSession => ({
    state: 'waiting',
    machineId: 'faraz-vip',
    activeAt: NOW,
    ...over,
});

const layout = (over: Partial<Parameters<typeof buildListLayout>[0]>) =>
    buildListLayout({ sessions: [], pinned: [], collapsed: [], ...over });
const keys = (l: ReturnType<typeof layout>) => l.map((x) => x.key);
const idsIn = (l: ReturnType<typeof layout>, key: string) =>
    l.find((x) => x.key === key)?.sessions.map((x) => x.id) ?? [];
/** Machine sections repeat the flat list, so they start shut; these specs are
 *  about placement, and open them to read what is inside. */
const open = (...machines: string[]) => ({ expanded: machines });

describe('sections', () => {
    it('is empty for an empty list', () => {
        expect(layout({})).toEqual([]);
    });

    it('reads twice: the flat list first, then the same sessions by machine', () => {
        const l = layout({
            sessions: [s({ id: 'a', machineId: 'fny' }), s({ id: 'b', machineId: 'boite' })],
        });
        expect(keys(l)).toEqual(['unpinned', 'm:boite', 'm:fny']);
    });

    it('has no pinned section until something is pinned, and no unpinned one when all are', () => {
        expect(keys(layout({ sessions: [s({ id: 'a' })] }))).toEqual(['unpinned', 'm:faraz-vip']);
        expect(keys(layout({ sessions: [s({ id: 'a' })], pinned: ['a'] }))).toEqual(['pinned', 'm:faraz-vip']);
    });

    it('puts the busiest machine first by default', () => {
        const l = layout({
            sessions: [
                s({ id: 'a', machineId: 'one' }),
                s({ id: 'b', machineId: 'two' }), s({ id: 'c', machineId: 'two' }),
            ],
        });
        expect(keys(l)).toEqual(['unpinned', 'm:two', 'm:one']);
    });

    it('honours an explicit machine order when the caller gives one', () => {
        const l = layout({
            sessions: [
                s({ id: 'a', machineId: 'one' }),
                s({ id: 'b', machineId: 'two' }), s({ id: 'c', machineId: 'two' }),
            ],
            machineOrder: ['one', 'two'],
        });
        expect(keys(l)).toEqual(['unpinned', 'm:one', 'm:two']);
    });

    it('sorts newest first inside a section', () => {
        const l = layout({
            sessions: [
                s({ id: 'older', activeAt: NOW - 5000 }),
                s({ id: 'newest', activeAt: NOW }),
                s({ id: 'middle', activeAt: NOW - 100 }),
            ],
        });
        expect(idsIn(l, 'm:faraz-vip')).toEqual(['newest', 'middle', 'older']);
    });

    it('keeps a session with no machine in its own section rather than dropping it', () => {
        const l = layout({ sessions: [s({ id: 'a', machineId: null })] });
        expect(keys(l)).toEqual(['unpinned', 'm:']);
        expect(l[1].machineId).toBeNull();
    });
});

describe('rule 1 — the list is read twice', () => {
    it('a pin moves a session between the two flat sections, never out of its machine', () => {
        const loose = layout({ sessions: [s({ id: 'a' })], ...open('m:faraz-vip') });
        expect(idsIn(loose, 'unpinned')).toEqual(['a']);
        expect(idsIn(loose, 'm:faraz-vip')).toEqual(['a']);

        const pinned = layout({ sessions: [s({ id: 'a' })], pinned: ['a'], ...open('m:faraz-vip') });
        expect(idsIn(pinned, 'pinned')).toEqual(['a']);
        expect(idsIn(pinned, 'unpinned')).toEqual([]);
        expect(idsIn(pinned, 'm:faraz-vip')).toEqual(['a'], );
    });

    it('a machine whose only session is pinned keeps its section', () => {
        const l = layout({ sessions: [s({ id: 'a', machineId: 'fny' })], pinned: ['a'], ...open('m:fny') });
        expect(keys(l)).toEqual(['pinned', 'm:fny']);
        expect(idsIn(l, 'm:fny')).toEqual(['a']);
    });

    it('every session appears exactly once up top and exactly once by machine', () => {
        const sessions = [
            s({ id: 'a', machineId: 'fny' }), s({ id: 'b', machineId: 'fny' }),
            s({ id: 'c', machineId: 'boite' }), s({ id: 'd', machineId: null }),
        ];
        const l = layout({ sessions, pinned: ['b', 'd'], expanded: ['m:fny', 'm:boite', 'm:'] });
        const flat = [...idsIn(l, 'pinned'), ...idsIn(l, 'unpinned')].sort();
        const byMachine = l.filter((x) => x.kind === 'machine').flatMap((x) => x.sessions.map((y) => y.id)).sort();
        expect(flat).toEqual(['a', 'b', 'c', 'd']);
        expect(byMachine).toEqual(['a', 'b', 'c', 'd']);
    });

    it('a pinned id that is not in the list is simply not a section', () => {
        expect(keys(layout({ sessions: [], pinned: ['ghost'] }))).toEqual([]);
    });

    it('both flat sections are ordered the same way', () => {
        const sessions = [
            s({ id: 'p-late', state: 'waiting', project: 'zeta' }),
            s({ id: 'p-urgent', state: 'blocked', project: 'alpha' }),
            s({ id: 'u-late', state: 'waiting', project: 'zeta' }),
            s({ id: 'u-urgent', state: 'blocked', project: 'alpha' }),
        ];
        const l = layout({ sessions, pinned: ['p-late', 'p-urgent'], pinnedSort: 'state' });
        expect(idsIn(l, 'pinned')).toEqual(['p-urgent', 'p-late']);
        expect(idsIn(l, 'unpinned')).toEqual(['u-urgent', 'u-late']);
    });
});

describe('rule 2 — a collapsed section still reports what is inside', () => {
    it('names the state that most wants a human, not the newest row', () => {
        const l = layout({
            sessions: [
                s({ id: 'a', state: 'thinking' }),
                s({ id: 'b', state: 'blocked' }),
                s({ id: 'c', state: 'waiting' }),
            ],
        });
        const m = l.find((x) => x.key === 'm:faraz-vip')!;
        expect(m.collapsed).toBe(true);
        expect(m.worstState).toBe('blocked');
        expect(m.sessions).toHaveLength(3); // the count survives collapse
    });

    it('machines start shut, because they repeat what is already above them', () => {
        const l = layout({ sessions: [s({ id: 'a', machineId: 'fny' }), s({ id: 'b', machineId: 'boite' })] });
        expect(l.filter((x) => x.kind === 'machine').every((x) => x.collapsed)).toBe(true);
    });

    it('expanding one machine leaves the others shut, and is remembered by key', () => {
        const l = layout({
            sessions: [s({ id: 'a', machineId: 'fny' }), s({ id: 'b', machineId: 'boite' })],
            expanded: ['m:fny'],
        });
        expect(l.find((x) => x.key === 'm:fny')!.collapsed).toBe(false);
        expect(l.find((x) => x.key === 'm:boite')!.collapsed).toBe(true);
    });

    it('the flat sections start open and each shuts on its own', () => {
        const sessions = [s({ id: 'a' }), s({ id: 'b' })];
        const openBoth = layout({ sessions, pinned: ['a'] });
        expect(openBoth.find((x) => x.key === 'pinned')!.collapsed).toBe(false);
        expect(openBoth.find((x) => x.key === 'unpinned')!.collapsed).toBe(false);

        const shut = layout({ sessions, pinned: ['a'], collapsed: ['pinned'] });
        expect(shut.find((x) => x.key === 'pinned')!.collapsed).toBe(true);
        expect(shut.find((x) => x.key === 'unpinned')!.collapsed).toBe(false);
    });
});

describe('partitionForList — the two ways pinning silently did nothing', () => {
    const part = (over: Partial<Parameters<typeof partitionForList>[0]>) =>
        partitionForList({ sessions: [], pinned: [], hideInactive: false, ...over });
    const ids = (xs: ListSession[]) => xs.map((x) => x.id);

    it('pins a RUNNING session — a pin outranks the active block', () => {
        const p = part({ sessions: [s({ id: 'a', active: true }), s({ id: 'b', active: true })], pinned: ['a'] });
        expect(ids(p.pins)).toEqual(['a']);
        expect(ids(p.active)).toEqual(['b']); // and it is not in both
    });

    it('pins a RUNNING session even when everything else is archived', () => {
        const p = part({ sessions: [s({ id: 'a', active: true }), s({ id: 'old' })], pinned: ['a'] });
        expect(ids(p.pins)).toEqual(['a']);
        expect(ids(p.archived)).toEqual(['old']);
    });

    it('a pin outranks being archived — it is still a pin', () => {
        const p = part({ sessions: [s({ id: 'old' })], pinned: ['old'] });
        expect(ids(p.pins)).toEqual(['old']);
        expect(ids(p.archived)).toEqual([]);
    });

    it('places every session exactly once', () => {
        const sessions = [s({ id: 'a', active: true }), s({ id: 'b' }), s({ id: 'c', active: true })];
        const p = part({ sessions, pinned: ['c'] });
        const seen = [...ids(p.pins), ...ids(p.active), ...ids(p.archived), ...ids(p.rest)];
        expect(seen.slice().sort()).toEqual(['a', 'b', 'c']);
        expect(new Set(seen).size).toBe(seen.length);
    });

    it('collects what the archived toggle reveals, whether or not it is showing', () => {
        // The partition no longer hides anything: what is DRAWN is the
        // caller's decision, because each kind now has its own divider and
        // its rows belong under it.
        const sessions = [s({ id: 'a', active: true }), s({ id: 'b' }), s({ id: 'c' })];
        expect(ids(part({ sessions }).archived)).toEqual(['b', 'c']);
        expect(part({ sessions: [s({ id: 'a', active: true })] }).archived).toEqual([]);
    });

    it('changes nothing when nothing is pinned', () => {
        const p = part({ sessions: [s({ id: 'a', active: true }), s({ id: 'b' })] });
        expect(ids(p.pins)).toEqual([]);
        expect(ids(p.active)).toEqual(['a']);
        expect(ids(p.archived)).toEqual(['b']);
    });
});

describe('the toggled kinds are partitioned out BEFORE the active block', () => {
    const part = (over: Partial<Parameters<typeof partitionForList>[0]>) =>
        partitionForList({ sessions: [], pinned: [], ...over });
    const ids = (xs: ListSession[]) => xs.map((x) => x.id);

    /**
     * The rule this function exists for. Archived, automation and headless
     * sessions each have a divider of their own near the BOTTOM of the list,
     * and their rows belong under it. Before this they were filters: flipping
     * one let its sessions appear wherever they would normally have gone —
     * including inside the active block — so a control at the bottom of the
     * list changed what was at the top of it.
     */
    it('an ACTIVE automation run never reaches the active block', () => {
        const p = part({ sessions: [s({ id: 'run', active: true, automation: 'running' }), s({ id: 'ordinary', active: true })] });
        expect(ids(p.automationsRunning)).toEqual(['run']);
        expect(ids(p.active)).toEqual(['ordinary']);
    });

    it('an ACTIVE headless session never reaches the active block', () => {
        const p = part({ sessions: [s({ id: 'quiet', active: true, headless: true }), s({ id: 'ordinary', active: true })] });
        expect(ids(p.headless)).toEqual(['quiet']);
        expect(ids(p.active)).toEqual(['ordinary']);
    });

    it('archived rows are their own bucket, not machine history mixed in above', () => {
        const p = part({ sessions: [s({ id: 'old' }), s({ id: 'live', active: true })] });
        expect(ids(p.archived)).toEqual(['old']);
        expect(ids(p.active)).toEqual(['live']);
    });

    it('a failed run outranks a pin and does not sit in the active block either', () => {
        const p = part({ sessions: [s({ id: 'broke', active: true, automation: 'failed' })], pinned: ['broke'] });
        expect(ids(p.automationsFailed)).toEqual(['broke']);
        expect(ids(p.pins)).toEqual([]);
        expect(ids(p.active)).toEqual([]);
    });

    it('a headless run that is ALSO an automation is an automation — one bucket, not two', () => {
        const p = part({ sessions: [s({ id: 'run', active: true, automation: 'running', headless: true })] });
        expect(ids(p.automationsRunning)).toEqual(['run']);
        expect(ids(p.headless)).toEqual([]);
    });

    it('places every session exactly once across all six buckets', () => {
        const sessions = [
            s({ id: 'failed', automation: 'failed' }),
            s({ id: 'running', automation: 'running' }),
            s({ id: 'quiet', headless: true }),
            s({ id: 'pinned' }),
            s({ id: 'active', active: true }),
            s({ id: 'history' }),
        ];
        const p = part({ sessions, pinned: ['pinned'] });
        const seen = [
            ...ids(p.automationsFailed), ...ids(p.automationsRunning), ...ids(p.headless),
            ...ids(p.pins), ...ids(p.active), ...ids(p.archived), ...ids(p.rest),
        ];
        expect(seen.slice().sort()).toEqual(['active', 'failed', 'history', 'pinned', 'quiet', 'running']);
        expect(new Set(seen).size).toBe(seen.length);
    });

    it('an ordinary list is unchanged — nothing is diverted that should not be', () => {
        const p = part({ sessions: [s({ id: 'a', active: true }), s({ id: 'b' })] });
        expect(p.automationsRunning).toEqual([]);
        expect(p.automationsFailed).toEqual([]);
        expect(p.headless).toEqual([]);
        expect(ids(p.active)).toEqual(['a']);
        expect(ids(p.archived)).toEqual(['b']);
    });
});

describe('the pinned order', () => {
    const pinnedIds = (over: Partial<Parameters<typeof buildListLayout>[0]>) =>
        buildListLayout({ sessions: [], pinned: [], collapsed: [], ...over })
            .find((x) => x.key === 'pinned')?.sessions.map((x) => x.id) ?? [];

    it('defaults to STATE — what needs you is at the top without asking', () => {
        const ids = pinnedIds({
            sessions: [
                s({ id: 'idle', state: 'disconnected', project: '~/aaa' }),
                s({ id: 'needs-me', state: 'permission_required', project: '~/zzz' }),
            ],
            pinned: ['idle', 'needs-me'],
            // no pinnedSort — project name would put ~/aaa first
        });
        expect(ids).toEqual(['needs-me', 'idle']);
    });

    it('inside one bucket it is project name, not recency', () => {
        const ids = pinnedIds({
            sessions: [
                s({ id: 'c', project: '~/work/zebra', activeAt: NOW }),
                s({ id: 'a', project: '~/work/apple', activeAt: NOW - 90_000 }),
                s({ id: 'b', project: '~/work/mango', activeAt: NOW - 1_000 }),
            ],
            pinned: ['a', 'b', 'c'],
        });
        expect(ids).toEqual(['a', 'b', 'c']);
    });

    it('orders by project name throughout when asked', () => {
        const ids = pinnedIds({
            sessions: [
                s({ id: 'idle', state: 'disconnected', project: '~/aaa' }),
                s({ id: 'needs-me', state: 'permission_required', project: '~/zzz' }),
            ],
            pinned: ['idle', 'needs-me'],
            pinnedSort: 'project',
        });
        expect(ids).toEqual(['idle', 'needs-me']);
    });

    it('does not reorder itself when a pinned agent speaks', () => {
        const before = [
            s({ id: 'a', project: '~/apple', activeAt: NOW - 50_000 }),
            s({ id: 'b', project: '~/mango', activeAt: NOW - 10_000 }),
        ];
        const after = [
            s({ id: 'a', project: '~/apple', activeAt: NOW }), // just spoke
            s({ id: 'b', project: '~/mango', activeAt: NOW - 10_000 }),
        ];
        expect(pinnedIds({ sessions: before, pinned: ['a', 'b'] }))
            .toEqual(pinnedIds({ sessions: after, pinned: ['a', 'b'] }));
    });

    it('by state: amber, then green, then blue, then grey', () => {
        const ids = pinnedIds({
            sessions: [
                s({ id: 'grey', state: 'disconnected', project: '~/a' }),
                s({ id: 'blue', state: 'thinking', project: '~/a' }),
                s({ id: 'green', state: 'unread', project: '~/a' }),
                s({ id: 'amber', state: 'permission_required', project: '~/a' }),
            ],
            pinned: ['grey', 'blue', 'green', 'amber'],
            pinnedSort: 'state',
        });
        expect(ids).toEqual(['amber', 'green', 'blue', 'grey']);
    });

    it('unread outranks working — a green row is above a pulsing blue one', () => {
        const ids = pinnedIds({
            sessions: [
                s({ id: 'busy', state: 'thinking', project: '~/a' }),
                s({ id: 'unread', state: 'unread', project: '~/b' }),
            ],
            pinned: ['busy', 'unread'],
            pinnedSort: 'state',
        });
        expect(ids).toEqual(['unread', 'busy']);
    });

    it('a read, idle session sorts to the bottom with the greys', () => {
        const ids = pinnedIds({
            sessions: [
                s({ id: 'seen', state: 'disconnected', project: '~/a' }),
                s({ id: 'working', state: 'agents', project: '~/b' }),
            ],
            pinned: ['seen', 'working'],
            pinnedSort: 'state',
        });
        expect(ids).toEqual(['working', 'seen']);
    });

    it('by state: falls back to project name inside a bucket, so it stays stable', () => {
        const ids = pinnedIds({
            sessions: [
                s({ id: 'z', state: 'thinking', project: '~/zebra', activeAt: NOW }),
                s({ id: 'a', state: 'tasks', project: '~/apple', activeAt: NOW - 99_000 }),
                s({ id: 'm', state: 'agents', project: '~/mango' }),
            ],
            pinned: ['z', 'a', 'm'],
            pinnedSort: 'state',
        });
        expect(ids).toEqual(['a', 'm', 'z']);
    });

    it('the order top to bottom: amber (needs you), unread, active, read, error, offline', () => {
        for (const state of ['permission_required', 'blocked']) expect(pinnedStateRank(state), state).toBe(0);
        expect(pinnedStateRank('unread')).toBe(1);
        for (const state of ['thinking', 'tasks', 'agents', 'compacting']) expect(pinnedStateRank(state), state).toBe(2);
        expect(pinnedStateRank('waiting')).toBe(3);
        for (const state of ['stalled', 'retrying', 'detached']) expect(pinnedStateRank(state), state).toBe(4);
        expect(pinnedStateRank('disconnected')).toBe(5);
    });

    it('a read, idle session sits above the errors and offline, below everything active', () => {
        const ids = pinnedIds({
            sessions: [
                s({ id: 'offline', state: 'disconnected', project: '~/a' }),
                s({ id: 'dead', state: 'detached', project: '~/b' }),
                s({ id: 'read', state: 'waiting', project: '~/c' }),
                s({ id: 'working', state: 'tasks', project: '~/d' }),
                s({ id: 'new', state: 'unread', project: '~/e' }),
                s({ id: 'login', state: 'blocked', project: '~/f' }),
            ],
            pinned: ['offline', 'dead', 'read', 'working', 'new', 'login'],
            pinnedSort: 'state',
        });
        expect(ids).toEqual(['login', 'new', 'working', 'read', 'dead', 'offline']);
    });

    it('ranks the pulsing working states together', () => {
        for (const state of ['thinking', 'tasks', 'agents', 'compacting']) {
            expect(pinnedStateRank(state)).toBe(2);
        }
    });

    it('unread is a state of its own: green, and the only green — read-and-idle is grey', () => {
        expect(pinnedDotColour('unread')).toBe('#34C759');
        expect(pinnedDotColour('waiting')).not.toBe('#34C759');
        expect(pinnedDotColour('waiting')).not.toBe(pinnedDotColour('disconnected'));
    });

    it('reads the dot straight off the shared palette, so the order is the one on screen', () => {
        for (const state of Object.keys(STATUS_PALETTE) as SessionState[]) {
            expect(pinnedDotColour(state)).toBe(STATUS_PALETTE[state].dotColor);
        }
    });

    it('every palette colour has a rank — a new one must be placed, not silently sorted last', () => {
        // The tripwire: add a colour to STATUS_PALETTE and this fails until
        // somebody decides where in the pinned order it belongs.
        const unplaced = (Object.keys(STATUS_PALETTE) as SessionState[])
            .filter((state) => pinnedStateRank(state) === 5 && state !== 'disconnected');
        expect(unplaced).toEqual([]);
    });

    it('sorts an unknown state last rather than to the front', () => {
        expect(pinnedStateRank('something-new')).toBe(5);
    });

    it('machine sections are still newest-first, while the flat list above is not', () => {
        const l = buildListLayout({
            sessions: [
                s({ id: 'old', project: '~/apple', activeAt: NOW - 5_000 }),
                s({ id: 'new', project: '~/zebra', activeAt: NOW }),
            ],
            pinned: [],
            collapsed: [],
            expanded: ['m:faraz-vip'],
        });
        expect(idsIn(l, 'm:faraz-vip')).toEqual(['new', 'old']);
        expect(idsIn(l, 'unpinned')).toEqual(['old', 'new']); // by project: apple, zebra
    });
});

describe('stateUrgency', () => {
    it('ranks waiting-on-a-human above anything merely running', () => {
        expect(stateUrgency('blocked')).toBeGreaterThan(stateUrgency('thinking'));
        expect(stateUrgency('permission_required')).toBeGreaterThan(stateUrgency('agents'));
        expect(stateUrgency('thinking')).toBeGreaterThan(stateUrgency('waiting'));
    });

    it('follows the pinned order: unread above active, read above the errors, offline last', () => {
        expect(stateUrgency('permission_required')).toBeGreaterThan(stateUrgency('unread'));
        expect(stateUrgency('unread')).toBeGreaterThan(stateUrgency('thinking'));
        expect(stateUrgency('waiting')).toBeGreaterThan(stateUrgency('detached'));
        expect(stateUrgency('detached')).toBeGreaterThan(stateUrgency('disconnected'));
    });

    it('gives an unknown state the bottom rank rather than throwing', () => {
        expect(stateUrgency('something-new')).toBe(0);
    });
});
