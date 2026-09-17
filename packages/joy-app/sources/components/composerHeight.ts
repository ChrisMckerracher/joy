/**
 * How tall a composer's text area should be (#648, and the regression it left).
 *
 * There are two jobs here, and conflating them is what broke the field:
 *
 *  - GROWING with the text is the platform's own job, and it is good at it: a
 *    multiline TextInput sizes itself to its content under a maxHeight cap.
 *  - SHRINKING when the text is cleared through `value` is the part iOS does
 *    NOT do. The last intrinsic height stays, so sending a twelve-line message
 *    left the empty box stranded at the cap.
 *
 * #648 fixed the shrink by pinning `height` to the content size reported by
 * onContentSizeChange on every render. That also took growth away from the
 * platform and handed it to a measurement — and where that measurement does
 * not grow (it reports the view's own height once the view has an explicit
 * one), the field is stuck at a single line however much you type.
 *
 * So the height is forced ONLY where the platform gets it wrong: an empty
 * field collapses to one line. With text in it the answer is null — no
 * explicit height, and the field sizes itself between minHeight and maxHeight
 * as it always did.
 */

export interface ComposerHeightInput {
    /** Is the field empty? Empty always collapses to one line. */
    isEmpty: boolean;
    /** One line of text, including the field's vertical padding. */
    minHeight: number;
}

/**
 * The explicit height to apply, or null to let the field size itself.
 *
 * Empty collapses unconditionally — it must not wait for a measurement to
 * arrive, because a stale measurement is exactly the bug this exists to fix.
 */
export function composerHeight({ isEmpty, minHeight }: ComposerHeightInput): number | null {
    if (!isEmpty) return null;
    return Math.max(1, minHeight);
}

/** How many lines a composer grows to before its content starts scrolling. */
export const COMPOSER_MAX_LINES = 3;

/**
 * The cap for a field that should show at most `lines` lines.
 *
 * Derived from the line height rather than written down as a pixel count, so
 * the visible LINE COUNT stays the same at every chat font scale — the pixel
 * cap moves with the text instead of silently showing fewer lines as the font
 * grows.
 */
export function maxHeightForLines(lines: number, lineHeight: number, verticalPadding: number): number {
    return Math.ceil(lineHeight * Math.max(1, lines) + Math.max(0, verticalPadding));
}
