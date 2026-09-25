/**
 * What an identicon stands for.
 *
 * 'project' is what the app has always drawn: a machine and a folder together,
 * so every session in one checkout on one box wears the same face. The others
 * trade that for a different grouping — one face per session, per machine, or
 * per agent — which is a device-local preference (Appearance → Identicons).
 *
 * Kept free of imports so it can be tested on its own: everything else in
 * `sessionUtils` reaches react-native, and a pure function should not need a
 * renderer to check.
 */
export type IdenticonSeed = 'project' | 'session' | 'machine' | 'agent';

/** The parts of a row an identicon can be drawn from. Every one of these is
 *  already on `SessionRowData`, so a row needs nothing new to re-seed. */
export interface AvatarIdentity {
    id: string;
    machineId?: string | null;
    path?: string | null;
    flavor?: string | null;
}

/**
 * Deterministic, and never empty: an unseeded identicon would be one blank
 * face shared by every row that happened to be missing a field, so each seed
 * falls back to the session id instead.
 *
 * Each grouping carries its own prefix, so a machine named `claude` cannot
 * collide with the agent of that name.
 */
export function avatarIdFor(identity: AvatarIdentity, seed: IdenticonSeed = 'project'): string {
    const { id, machineId, path, flavor } = identity;
    switch (seed) {
        case 'session': return id;
        case 'machine': return machineId ? `machine:${machineId}` : id;
        case 'agent': return flavor ? `agent:${flavor}` : id;
        case 'project':
        default:
            return machineId && path ? `${machineId}:${path}` : id;
    }
}
