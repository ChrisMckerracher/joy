import { describe, expect, it } from 'vitest';
import { avatarIdFor } from './avatarId';

const row = { id: 'c6787bf4', machineId: 'faraz-vip', path: '/home/claude/Workspace/joy', flavor: 'claude' };

describe('avatarIdFor', () => {
    it('defaults to what the app has always drawn: machine and folder together', () => {
        expect(avatarIdFor(row)).toBe('faraz-vip:/home/claude/Workspace/joy');
        expect(avatarIdFor(row, 'project')).toBe(avatarIdFor(row));
    });

    it('gives one face per grouping, and never mixes two groupings up', () => {
        expect(avatarIdFor(row, 'session')).toBe('c6787bf4');
        expect(avatarIdFor(row, 'machine')).toBe('machine:faraz-vip');
        expect(avatarIdFor(row, 'agent')).toBe('agent:claude');
        // A machine called `claude` must not collide with the agent of that
        // name, which is why each seed carries its own prefix.
        expect(avatarIdFor({ ...row, machineId: 'claude' }, 'machine')).not.toBe(avatarIdFor(row, 'agent'));
    });

    it('two sessions in one folder share a face, and two folders never do', () => {
        const other = { ...row, id: 'dab35bff' };
        expect(avatarIdFor(other)).toBe(avatarIdFor(row));
        expect(avatarIdFor(other, 'session')).not.toBe(avatarIdFor(row, 'session'));
        expect(avatarIdFor({ ...row, path: '/home/claude/Workspace/envx' })).not.toBe(avatarIdFor(row));
    });

    it('falls back to the session id rather than drawing one blank face for everything', () => {
        const bare = { id: 'abcd1234' };
        for (const seed of ['project', 'session', 'machine', 'agent'] as const) {
            expect(avatarIdFor(bare, seed)).toBe('abcd1234');
        }
        expect(avatarIdFor({ id: 'x', machineId: 'm' }, 'project')).toBe('x'); // a path is required too
    });
});
