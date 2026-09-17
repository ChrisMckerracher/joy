import { describe, it, expect } from 'vitest';
import { composerHeight, maxHeightForLines, COMPOSER_MAX_LINES } from './composerHeight';

describe('composerHeight', () => {
    it('collapses to one line when empty — that is the one thing the platform gets wrong', () => {
        // A long message is sent, the field clears, and without this the last
        // intrinsic height never goes away.
        expect(composerHeight({ isEmpty: true, minHeight: 40 })).toBe(40);
    });

    it('forces nothing while there is text, so the field grows on its own', () => {
        // The regression: pinning a height here handed growth to a measurement
        // that does not grow on every device, and the field stuck at one line.
        expect(composerHeight({ isEmpty: false, minHeight: 40 })).toBeNull();
    });

    it('never collapses to a nonsensical floor', () => {
        expect(composerHeight({ isEmpty: true, minHeight: 0 })).toBe(1);
        expect(composerHeight({ isEmpty: true, minHeight: -10 })).toBe(1);
    });
});

describe('maxHeightForLines', () => {
    it('caps at the requested number of lines plus the field padding', () => {
        // One line of 22 plus 16 of padding is the collapsed height; three
        // lines is what the composer grows to before it scrolls.
        expect(maxHeightForLines(1, 22, 16)).toBe(38);
        expect(maxHeightForLines(COMPOSER_MAX_LINES, 22, 16)).toBe(82);
    });

    it('scales with the line height, so the visible line count is what stays fixed', () => {
        expect(maxHeightForLines(3, 28, 16)).toBe(100);
        expect(maxHeightForLines(3, 17, 16)).toBe(67);
    });

    it('rounds up so a fractional line is never clipped', () => {
        expect(maxHeightForLines(3, 21.5, 16)).toBe(81);
    });

    it('never returns less than a single line, whatever it is asked for', () => {
        expect(maxHeightForLines(0, 22, 16)).toBe(38);
        expect(maxHeightForLines(-2, 22, 0)).toBe(22);
    });
});
