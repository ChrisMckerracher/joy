import { afterEach, describe, expect, it, vi } from 'vitest';
import { isFollowInteracting, performBottomFollow, shouldFollowBottom, updateFollowScroll, type FollowInput, type FollowScrollState } from './chatFollow';

const live: FollowInput = { loaded: true, restoring: false, nearBottom: true, interacting: false };

describe('shouldFollowBottom', () => {
    it('follows only when loaded, not restoring, near the bottom and hands-off', () => {
        expect(shouldFollowBottom(live)).toBe(true);
    });

    it('a reader away from the bottom is never pulled down', () => {
        expect(shouldFollowBottom({ ...live, nearBottom: false })).toBe(false);
    });

    it('a finger on the screen or a fling in progress is never fought, even at the bottom', () => {
        expect(shouldFollowBottom({ ...live, interacting: true })).toBe(false);
    });

    it('a restore in flight is not undone', () => {
        expect(shouldFollowBottom({ ...live, restoring: true })).toBe(false);
    });

    it('before the first layout the list positions itself', () => {
        expect(shouldFollowBottom({ ...live, loaded: false })).toBe(false);
    });

    it('exhaustive: exactly one of the sixteen combinations follows', () => {
        let follows = 0;
        for (const loaded of [true, false]) for (const restoring of [true, false])
            for (const nearBottom of [true, false]) for (const interacting of [true, false]) {
                if (shouldFollowBottom({ loaded, restoring, nearBottom, interacting })) follows++;
            }
        expect(follows).toBe(1);
    });
});

describe('automatic follow command ordering', () => {
    afterEach(() => { vi.useRealTimers(); });

    it.each([0, 200])('does not leave a %ims FlashList command that can re-arm and repeat after scrolling up', (delay) => {
        vi.useFakeTimers();
        const sequence = createScrollSequence();
        let offset = 1400;
        let contentHeight = 2000;
        let commandsAfterScrollUp = 0;
        let scrolledUp = false;
        const native = {
            scrollToEnd() {
                if (scrolledUp) commandsAfterScrollUp++;
                offset = contentHeight - 600;
                sequence.scroll(offset, contentHeight);
            },
        };
        const flashList = {
            getNativeScrollRef: () => native,
            scrollToEnd() {
                // FlashList 2.3.1: if the last row is unengaged, scrollToIndex
                // positions it, then resolves 200ms later. Both paths finally
                // schedule another native scrollToEnd with setTimeout(0).
                if (delay) native.scrollToEnd();
                setTimeout(() => native.scrollToEnd(), delay);
            },
        };
        sequence.scroll(offset);
        for (let batch = 0; batch < 3; batch++) {
            scrolledUp = false;
            // Growth can leave live mode enabled beyond the engaged buffer.
            contentHeight += delay ? 1200 : 20;
            sequence.scroll(offset, contentHeight);
            performBottomFollow({ ...live, nearBottom: sequence.follows() }, flashList);
            offset -= 20;
            sequence.scroll(offset, contentHeight);
            scrolledUp = true;
            expect(sequence.follows()).toBe(false);
            vi.runAllTimers(); // old command lands here and re-arms the latch
        }
        expect(commandsAfterScrollUp).toBe(0);
        expect(sequence.follows()).toBe(false);
    });

    it('blocks every streamed follow during wheel input even if an old bottom event re-arms live mode', () => {
        vi.useFakeTimers();
        const native = { scrollToEnd: vi.fn() };
        const list = { getNativeScrollRef: () => native, scrollToEnd: vi.fn() };
        for (let now = 1000; now < 1500; now += 50) {
            const wheelUntil = now + 150;
            performBottomFollow({
                ...live, // also covers a bottom report from a prior command
                interacting: isFollowInteracting(false, wheelUntil, now + 10),
            }, list);
            vi.runAllTimers();
        }
        expect(list.scrollToEnd).not.toHaveBeenCalled();
        expect(native.scrollToEnd).not.toHaveBeenCalled();
    });

    it('follows new measurements directly while live, including growth beyond the engaged window', () => {
        const sequence = createScrollSequence();
        const native = { scrollToEnd: vi.fn() };
        const list = { getNativeScrollRef: () => native, scrollToEnd: vi.fn() };
        sequence.scroll(1400);
        for (const contentHeight of [3200, 3300]) {
            sequence.scroll(1400, contentHeight);
            performBottomFollow({ ...live, nearBottom: sequence.follows() }, list);
        }
        expect(native.scrollToEnd).toHaveBeenCalledTimes(2);
        expect(native.scrollToEnd).toHaveBeenLastCalledWith({ animated: false });
        expect(list.scrollToEnd).not.toHaveBeenCalled();
    });

    it('wheel idle expiry permits a live follow but does not re-arm an upward reader', () => {
        const sequence = createScrollSequence();
        const native = { scrollToEnd: vi.fn() };
        const list = { getNativeScrollRef: () => native };
        const wheelUntil = 1150;
        expect(isFollowInteracting(false, wheelUntil, 1149)).toBe(true);
        expect(isFollowInteracting(false, wheelUntil, 1150)).toBe(false);
        expect(isFollowInteracting(true, wheelUntil, 1300)).toBe(true);
        sequence.scroll(1400);
        sequence.scroll(1380);
        performBottomFollow({
            ...live,
            nearBottom: sequence.follows(),
            interacting: isFollowInteracting(false, wheelUntil, 1300),
        }, list);
        expect(native.scrollToEnd).not.toHaveBeenCalled();
        sequence.scroll(1390); // the reader intentionally returns down
        performBottomFollow({
            ...live,
            nearBottom: sequence.follows(),
            interacting: isFollowInteracting(false, wheelUntil, 1300),
        }, list);
        expect(native.scrollToEnd).toHaveBeenCalledOnce();
    });

    it('the command retains load, restore, and native-interaction guards', () => {
        const native = { scrollToEnd: vi.fn() };
        const list = { getNativeScrollRef: () => native };
        for (const input of [
            { ...live, loaded: false },
            { ...live, restoring: true },
            { ...live, interacting: true },
            { ...live, nearBottom: false },
        ]) performBottomFollow(input, list);
        expect(native.scrollToEnd).not.toHaveBeenCalled();
        expect(() => performBottomFollow(live, null)).not.toThrow();
        expect(() => performBottomFollow(live, { getNativeScrollRef: () => null })).not.toThrow();
    });
});

// Replay the events that feed ChatList's refs. No rendered FlashList is needed:
// the regression is a follow permission after an upward scroll inside 48px.
function createScrollSequence() {
    let scroll: FollowScrollState | null = null;
    let interacting = false;
    return {
        scroll(offset: number, contentHeight = 2000, viewportHeight = 600) {
            scroll = updateFollowScroll(scroll, {
                contentOffset: { y: offset },
                contentSize: { height: contentHeight },
                layoutMeasurement: { height: viewportHeight },
            });
        },
        interact(value: boolean) { interacting = value; },
        follows() {
            return shouldFollowBottom({ ...live, nearBottom: scroll?.nearBottom ?? true, interacting });
        },
    };
}

describe('scroll events feeding bottom follow', () => {
    it('desktop: a small wheel scroll up disarms follow without drag callbacks', () => {
        const sequence = createScrollSequence();
        sequence.scroll(1400);
        expect(sequence.follows()).toBe(true);
        sequence.scroll(1380); // 20px up, still inside the 48px live band
        expect(sequence.follows()).toBe(false); // next streamed update
        sequence.scroll(1380); // RN-Web sends another onScroll after 100ms idle
        expect(sequence.follows()).toBe(false);
    });

    it('iOS: releasing a small upward drag without momentum must not re-arm follow', () => {
        const sequence = createScrollSequence();
        sequence.scroll(1400);
        sequence.interact(true); // onScrollBeginDrag
        sequence.scroll(1380);
        expect(sequence.follows()).toBe(false);
        sequence.interact(false); // onScrollEndDrag, no subsequent momentum events
        expect(sequence.follows()).toBe(false); // onContentSizeChange
    });

    it('iOS: the drag-to-momentum gap must not pull an upward gesture back down', () => {
        const sequence = createScrollSequence();
        sequence.scroll(1400);
        sequence.interact(true);
        sequence.scroll(1380);
        sequence.interact(false); // before onMomentumScrollBegin arrives
        expect(sequence.follows()).toBe(false);
        sequence.interact(true);
        sequence.scroll(1360);
        sequence.interact(false);
        expect(sequence.follows()).toBe(false);
    });

    it('returning down into the live band re-arms follow', () => {
        const sequence = createScrollSequence();
        sequence.scroll(1400);
        sequence.scroll(1100); // reading, like the Up button's target
        expect(sequence.follows()).toBe(false);
        sequence.scroll(1340); // still 60px away
        expect(sequence.follows()).toBe(false);
        sequence.scroll(1360); // down into the 48px band
        expect(sequence.follows()).toBe(true);
    });

    it('a downward return within the live band re-arms after a small upward scroll', () => {
        const sequence = createScrollSequence();
        sequence.scroll(1400);
        sequence.scroll(1380);
        expect(sequence.follows()).toBe(false);
        sequence.scroll(1390);
        expect(sequence.follows()).toBe(true);
    });

    it('upward movement still disarms when content grows in the same scroll event', () => {
        const sequence = createScrollSequence();
        sequence.scroll(1400);
        sequence.scroll(1380, 2020); // 20px up plus 20px of new content
        expect(sequence.follows()).toBe(false);
    });

    it('a reader stays detached through idle events and anchor corrections after a prepend', () => {
        const sequence = createScrollSequence();
        sequence.scroll(1400);
        sequence.scroll(1380);
        sequence.scroll(1480, 2100); // anchor moves 100px with prepended content
        sequence.scroll(1480, 2100);
        expect(sequence.follows()).toBe(false);
    });

    it('a stationary live reader can follow growth between scroll events', () => {
        const sequence = createScrollSequence();
        sequence.scroll(1400);
        // Data/content-size callbacks consult the last scroll state. They must
        // not reinterpret content growth as an upward user gesture.
        expect(sequence.follows()).toBe(true);
        sequence.scroll(1500, 2100); // the follow lands at the new end
        expect(sequence.follows()).toBe(true);
    });

    it('a live reader stays attached when a scroll event reports growth before the follow moves', () => {
        const sequence = createScrollSequence();
        sequence.scroll(1400);
        sequence.scroll(1400, 2200); // 200px growth, no movement yet
        expect(sequence.follows()).toBe(true);
        sequence.scroll(1400, 2200); // a duplicate/idle event must preserve live mode too
        expect(sequence.follows()).toBe(true);
        sequence.scroll(1600, 2200); // the follow finally catches up
        expect(sequence.follows()).toBe(true);
    });

    it('upward intent still detaches a live reader while a large growth batch is pending', () => {
        const sequence = createScrollSequence();
        sequence.scroll(1400);
        sequence.scroll(1400, 2200);
        expect(sequence.follows()).toBe(true);
        sequence.scroll(1380, 2200);
        expect(sequence.follows()).toBe(false);
        sequence.scroll(1380, 2400);
        expect(sequence.follows()).toBe(false);
    });

    it('content growth does not re-attach a reader who already scrolled away', () => {
        const sequence = createScrollSequence();
        sequence.scroll(1400);
        sequence.scroll(1380);
        sequence.scroll(1380, 2200);
        expect(sequence.follows()).toBe(false);
    });

    it('bottom overscroll and its bounce back leave follow enabled', () => {
        const sequence = createScrollSequence();
        sequence.scroll(1400);
        sequence.scroll(1420);
        sequence.scroll(1400);
        expect(sequence.follows()).toBe(true);
    });

    it('content collapse and viewport resizing at the bottom leave follow enabled', () => {
        const sequence = createScrollSequence();
        sequence.scroll(1400);
        sequence.scroll(1300, 1900);
        expect(sequence.follows()).toBe(true);
        sequence.scroll(1200, 1900, 700);
        expect(sequence.follows()).toBe(true);
    });

    it('anchor corrections inside the live band do not count as upward intent', () => {
        const sequence = createScrollSequence();
        sequence.scroll(1380);
        expect(sequence.follows()).toBe(true);
        sequence.scroll(1280, 1900); // 100px collapse above the anchor, still 20px away
        expect(sequence.follows()).toBe(true);
    });

    it('short content stays live until it fills the viewport', () => {
        const sequence = createScrollSequence();
        sequence.scroll(0, 400);
        expect(sequence.follows()).toBe(true);
        sequence.scroll(0, 600);
        expect(sequence.follows()).toBe(true);
    });
});
