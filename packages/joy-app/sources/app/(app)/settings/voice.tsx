import React from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable } from '@/sync/storage';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { endVoice } from '@/realtime/RealtimeSession';

const voices = ['alba', 'marius', 'javert', 'jean', 'fantine', 'cosette', 'eponine', 'azelma'] as const;
export default React.memo(function VoiceSettingsScreen() {
    const { theme } = useUnistyles();
    const [voice, setVoice] = useSettingMutable('pocketTtsVoice');
    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup title="Pocket TTS" footer={t('pocketVoice.description')}>
                {voices.map(name => (
                    <Item key={name} title={name[0].toUpperCase() + name.slice(1)}
                        rightElement={voice === name ? <Ionicons name="checkmark" size={20} color={theme.colors.textLink} /> : undefined}
                        showChevron={false} onPress={() => { void endVoice(); setVoice(name); }} />
                ))}
            </ItemGroup>
            <ItemGroup title={t('pocketVoice.setup')} footer={t('pocketVoice.privacy')}>
                <Item title={t('pocketVoice.setupInstructions')} titleStyle={{ fontSize: 13 }} showChevron={false} />
            </ItemGroup>
        </ItemList>
    );
});
