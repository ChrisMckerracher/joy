import { describe, it, expect } from 'vitest';
import { daemonCompatibility, isCompatWarning, DAEMON_COMPAT } from './daemonCompat';

const limits = { min: '1.5.0', maxKnownMajor: 2 };

describe('daemonCompatibility', () => {
    it('a daemon inside the table is usable', () => {
        expect(daemonCompatibility('1.5.0', limits)).toBe('ok');
        expect(daemonCompatibility('1.9.3', limits)).toBe('ok');
        expect(daemonCompatibility('2.0.0', limits)).toBe('ok');
    });

    it('below the floor asks for the MACHINE to update', () => {
        expect(daemonCompatibility('1.4.9', limits)).toBe('daemon_too_old');
        expect(daemonCompatibility('0.1.0', limits)).toBe('daemon_too_old');
    });

    it('past the highest known major asks for the APP to update', () => {
        expect(daemonCompatibility('3.0.0', limits)).toBe('app_too_old');
        expect(daemonCompatibility('9.9.9', limits)).toBe('app_too_old');
    });

    it('a future major wins over the floor, so the message names the right side', () => {
        // Both rules could fire if a table's floor were above a future major;
        // the newer-peer verdict is the honest one — we cannot judge it.
        expect(daemonCompatibility('3.0.0', { min: '4.0.0', maxKnownMajor: 2 })).toBe('app_too_old');
    });

    it('missing or malformed versions warn about nothing (#645)', () => {
        expect(daemonCompatibility(undefined, limits)).toBe('unknown');
        expect(daemonCompatibility('', limits)).toBe('unknown');
        expect(daemonCompatibility('not-a-version', limits)).toBe('unknown');
        expect(daemonCompatibility('0.invalid.0', limits)).toBe('unknown');
    });

    it('a labelled version still compares honestly (pre-#645 daemons)', () => {
        expect(daemonCompatibility('joy-daemon/0.1.0', limits)).toBe('daemon_too_old');
    });

    it('only the two mismatches are worth showing', () => {
        expect(isCompatWarning('ok')).toBe(false);
        expect(isCompatWarning('unknown')).toBe(false);
        expect(isCompatWarning('daemon_too_old')).toBe(true);
        expect(isCompatWarning('app_too_old')).toBe(true);
    });

    it('the shipped table accepts the daemon in the field today', () => {
        expect(daemonCompatibility('1.11.3')).toBe('ok');
        expect(daemonCompatibility('0.9.0')).toBe('daemon_too_old');
        expect(daemonCompatibility(`${DAEMON_COMPAT.maxKnownMajor + 1}.0.0`)).toBe('app_too_old');
    });
});
