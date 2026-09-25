import * as React from 'react';
import { useLocalSetting } from '@/sync/storage';
import { avatarIdFor, type AvatarIdentity, type IdenticonSeed } from '@/utils/avatarId';

/**
 * The identicon seed for a row, under whatever Appearance → Identicons says.
 *
 * The row already carries every part an identicon can be drawn from, so
 * changing what a face stands for costs nothing at the data layer: the
 * preference is read once here and applied at the call site. `avatarId` on the
 * row stays the project-seeded value, which is what everything outside the
 * session list (and every stored reference) still means.
 */
export function useIdenticonSeed(): (identity: AvatarIdentity) => string {
    const seed = useLocalSetting('identiconSeed') as IdenticonSeed;
    return React.useCallback((identity: AvatarIdentity) => avatarIdFor(identity, seed), [seed]);
}
