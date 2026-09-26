import React from 'react';
import { Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { ItemList } from '@/components/ItemList';
import { t } from '@/text';
import notices from '@/realtime/pocket/notices.json';

// Bundled in both clients so attribution and license terms remain available
// without a network connection or a link to a temporary development branch.
export default function VoiceLicenses() {
    const { theme } = useUnistyles();
    return <>
        <Stack.Screen options={{ title: t('pocketVoice.licenses') }} />
        <ItemList>
            {notices.map(notice => <View key={notice.name} style={{ padding: 16 }}>
                <Text style={{ color: theme.colors.text, fontWeight: '600', marginBottom: 12 }}>{notice.name}</Text>
                <Text selectable style={{ color: theme.colors.text, fontSize: 13, lineHeight: 20 }}>{notice.lines.join('\n')}</Text>
            </View>)}
        </ItemList>
    </>;
}
