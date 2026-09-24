/**
 * Whether the chat list should follow new content to the bottom right now.
 *
 * FlashList's own `autoscrollToBottomThreshold` used to do this. Two things
 * made it yank a reader back down: its band was a fraction of the viewport
 * (20% — 120px or more on a phone), far wider than the 48px this list
 * already calls "live"; and it ran on every data change with no idea whether
 * a finger was on the screen or a fling was still moving, so during a stream
 * — a data change several times a second — scrolling up from the bottom was
 * answered by an animated scroll straight back. "Sometimes when I scroll up
 * the text jumps back to the bottom."
 *
 * So following is decided here, from what the list actually knows: the last
 * real scroll event's distance and direction, and whether the user is
 * mid-gesture. Pure so the four inputs can be checked exhaustively.
 * Distance alone still fought small upward scrolls: RN-Web does not send
 * drag/momentum callbacks, and iOS clears the gesture guard on release.
 * updateFollowScroll remembers moving away even inside the 48px live band.
 */
export interface FollowInput {
    /** onLoad has fired: the list has laid out its first window. Before
     *  that, FlashList's startRenderingFromBottom owns the position. */
    loaded: boolean;
    /** A saved reading position is being restored; a follow would undo it. */
    restoring: boolean;
    /** Live mode from the last scroll event; new content can extend beyond
     *  the live band before the follow catches up. Upward intent leaves it. */
    nearBottom: boolean;
    /** Native drag/momentum, or recent wheel input on RN-Web. */
    interacting: boolean;
}

export function shouldFollowBottom(input: FollowInput): boolean {
    if (!input.loaded || input.restoring) return false;
    if (input.interacting) return false;
    return input.nearBottom;
}

interface BottomScroller {
    scrollToEnd: (options: { animated: boolean }) => void;
}

interface FollowList {
    getNativeScrollRef: () => BottomScroller | null;
}

/** Keep the follow check and its command together for event-sequence tests. */
export function performBottomFollow(input: FollowInput, list: FollowList | null): void {
    if (!shouldFollowBottom(input)) return;
    // FlashList.scrollToEnd queues a native command after setTimeout(0), or
    // after scrollToIndex's 200ms settling delay if the last row is unengaged.
    // An upward scroll can revoke follow meanwhile, but the queued command
    // still lands, re-arms live mode, and starts the cycle again. Issue only
    // the native command now, while the guard holds. Data/measurement callbacks
    // retry at new heights; initial positioning and explicit navigation still
    // use FlashList. Its own automatic-bottom path uses this ScrollView too.
    // Not animated: repeated streaming updates must not overlap animations.
    list?.getNativeScrollRef()?.scrollToEnd({ animated: false });
}

export function isFollowInteracting(nativeInteracting: boolean, wheelUntil: number, now: number): boolean {
    return nativeInteracting || now < wheelUntil;
}

// "Live" is a much tighter band than the 300px scroll-button threshold:
// someone 250px up is reading. The same state feeds lifecycle snapshots.
const LIVE_THRESHOLD = 48;

interface ScrollMetrics {
    contentOffset: { y: number };
    contentSize: { height: number };
    layoutMeasurement: { height: number };
}

export interface FollowScrollState {
    offset: number;
    distanceFromBottom: number;
    nearBottom: boolean;
}

/** Leaving live mode depends on direction, not just crossing the live band.
 *  Returning down into the band re-arms follow. Duplicate/idle scroll events
 *  keep the previous decision, so RN-Web's final onScroll cannot undo it. */
export function updateFollowScroll(
    previous: FollowScrollState | null,
    event: ScrollMetrics,
): FollowScrollState {
    const maxOffset = Math.max(0, event.contentSize.height - event.layoutMeasurement.height);
    // Ignore elastic overscroll: bouncing back from beyond the bottom is not
    // a request to read older content.
    const offset = Math.max(0, Math.min(event.contentOffset.y, maxOffset));
    const distanceFromBottom = maxOffset - offset;
    let nearBottom = distanceFromBottom <= LIVE_THRESHOLD;
    if (previous) {
        const previousMaxOffset = previous.offset + previous.distanceFromBottom;
        const endGrowth = Math.max(0, maxOffset - previousMaxOffset);
        // Only distance growth beyond the movement of the end means moving
        // away. This also excludes collapse/resize corrections toward the end.
        const movedAway = distanceFromBottom - previous.distanceFromBottom > endGrowth;
        const movedBack = offset > previous.offset && distanceFromBottom < previous.distanceFromBottom;
        // A live reader stays live through growth and duplicate scroll events,
        // even outside 48px while a follow is pending. The band only gates a
        // reader's return to live mode, not content growing beneath them.
        nearBottom = previous.nearBottom
            ? !movedAway
            : nearBottom && (movedBack || distanceFromBottom === 0);
    }
    return { offset, distanceFromBottom, nearBottom };
}

/**
 * Which turn's agent work stays unfolded. While the agent works, its tool
 * calls show as rows; folding them into one "agent work" group the instant
 * the turn ends removed the rows a reader was looking at and, with them, the
 * anchor the list held the viewport on — "it jumps when a new message comes
 * in". So the latest turn is held open from the moment it starts thinking
 * until the NEXT prompt arrives; the fold then lands in the same commit as
 * the new row, where the follow is already moving the viewport. A session
 * opened at rest (nothing thinking) folds its last turn as before.
 */
export function heldOpenTurn(held: string | null, thinking: boolean, latestPromptId: string | null): string | null {
    if (thinking) return latestPromptId;
    return held === latestPromptId ? held : null;
}
