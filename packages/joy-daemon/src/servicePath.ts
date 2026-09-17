// The PATH `joy install` bakes into the service file — a pure function so its
// filtering is testable without running the installer (as with launchdPlist).
//
// The installer used to copy the installing shell's PATH verbatim. With fnm
// that PATH contains PER-SHELL directories:
//
//   /run/user/1000/fnm_multishells/<pid>_<ts>/bin        (Linux, tmpfs)
//   ~/.local/state/fnm_multishells/<pid>_<ts>/bin        (macOS)
//
// They are created by `eval "$(fnm env)"` for one shell and are gone after a
// reboot. The DAEMON survives that, because its exec line names an absolute
// node. Everything the daemon spawns does not: tmux is started without an env
// of its own, so every session inherits this PATH, and after a reboot `node`,
// `npx`, `pnpm` and hook callbacks to `joy` inside sessions fail with "command
// not found" (reported 2026-09-17; on the box that found it, node resolved
// ONLY through such a directory).
//
// So: put the interpreter that will actually run the service first, then fnm's
// stable alias if the machine has one, then everything else with the transient
// entries removed. Order is otherwise preserved — this is somebody's PATH and
// the precedence in it is deliberate.
//
// Entries that do not exist are KEPT. A directory absent at install time may
// be created later (a version manager's first install, a tool added next
// week), and dropping it would silently change behaviour long after the fact.
// Only provably-transient entries go.

/** Per-shell fnm directories, on either platform. */
const TRANSIENT = /(^|\/)fnm_multishells\//;

export interface ServicePathParts {
    /** Directory of the node that will run the service (dirname of execPath). */
    nodeDir: string;
    /** fnm's stable alias dir, when the machine has one. Survives a reboot. */
    aliasDir?: string | null;
}

/**
 * The PATH to write into the unit or plist.
 * Deduplicated, transient entries dropped, the service's own node first.
 */
export function serviceEnvPath(raw: string, parts: ServicePathParts): string {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (dir: string) => {
        if (!dir || seen.has(dir) || TRANSIENT.test(dir)) return;
        seen.add(dir);
        out.push(dir);
    };
    push(parts.nodeDir);
    if (parts.aliasDir) push(parts.aliasDir);
    for (const dir of (raw ?? "").split(":")) push(dir);
    return out.join(":");
}

/** True when a PATH carries directories that will not survive a reboot. */
export function hasTransientEntries(raw: string): boolean {
    return (raw ?? "").split(":").some((d) => TRANSIENT.test(d));
}
