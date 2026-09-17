/**
 * Which daemon versions this app can work with.
 *
 * Both halves of the comparison already travel: the daemon publishes its own
 * version on every machine record and every session's metadata (declared
 * schema fields, so unlike `capabilities` they are never stripped), and the
 * app knows its own. So the whole compatibility rule can live here, in a table
 * the app ships, and no new wire field is needed.
 *
 * The check is TWO-SIDED on purpose. The old one asked only "is this daemon
 * below our floor", which cannot see the opposite failure: a daemon that
 * migrated its own data in a way this app does not understand yet. That case
 * is the common one, because a daemon updates with one push while the app
 * waits on a store review or an over-the-air publish.
 *
 * An app can only judge daemons its table knows about. A daemon whose MAJOR
 * is above `maxKnownMajor` is therefore reported as "newer than this app
 * understands" rather than guessed at — the standard way protocols handle a
 * peer from the future, and it needs no field this app was not compiled with.
 */
import { compareVersions, parseVersion, MINIMUM_CLI_VERSION } from './versionUtils';

export const DAEMON_COMPAT = {
    /** The oldest daemon this app can talk to at all. */
    min: MINIMUM_CLI_VERSION,
    /**
     * The highest daemon MAJOR this app was built to understand. Raise it in
     * the same change that teaches the app a new daemon's behaviour; a daemon
     * above it is assumed to have migrated past us.
     */
    maxKnownMajor: 1,
} as const;

export type DaemonCompat =
    /** Usable. */
    | 'ok'
    /** Below the floor: the MACHINE needs `joy update`. */
    | 'daemon_too_old'
    /** Past what this app understands: the APP needs updating. */
    | 'app_too_old'
    /** Missing or unparseable — say nothing rather than guess. */
    | 'unknown';

export interface DaemonCompatLimits {
    min: string;
    maxKnownMajor: number;
}

/**
 * Judge a daemon version against this app's table.
 *
 * `unknown` is deliberate and is NOT a warning: a daemon that reports nothing
 * (or something malformed) must not be accused of being out of date, which is
 * the mistake that made every daemon read as outdated once before (#645).
 */
export function daemonCompatibility(
    daemonVersion: string | undefined | null,
    limits: DaemonCompatLimits = DAEMON_COMPAT,
): DaemonCompat {
    if (!daemonVersion) return 'unknown';
    const parsed = parseVersion(daemonVersion);
    if (!parsed) return 'unknown';
    if (parsed.major > limits.maxKnownMajor) return 'app_too_old';
    try {
        return compareVersions(daemonVersion, limits.min) < 0 ? 'daemon_too_old' : 'ok';
    } catch {
        return 'unknown';
    }
}

/** True when the verdict is worth putting in front of someone. */
export function isCompatWarning(v: DaemonCompat): boolean {
    return v === 'daemon_too_old' || v === 'app_too_old';
}
