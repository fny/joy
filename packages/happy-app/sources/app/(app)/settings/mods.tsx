import * as React from 'react';
import { Switch } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable } from '@/sync/storage';
import { Modal } from '@/modal';
import { t } from '@/text';

export default React.memo(function ModsSettingsScreen() {
    const [modXhighEnabled, setModXhighEnabled] = useSettingMutable('joy__xHighEnabled');
    const [modHideModesEnabled, setModHideModesEnabled] = useSettingMutable('joy__hideModesEnabled');
    const [chatHistoryLimit, setChatHistoryLimit] = useSettingMutable('joy__chatHistoryLimit');
    const [modDoubleTapEnabled, setModDoubleTapEnabled] = useSettingMutable('joy__doubleTapEnabled');
    const [modReadOpenFileEnabled, setModReadOpenFileEnabled] = useSettingMutable('joy__readOpenFileEnabled');

    const handleChatHistoryLimit = React.useCallback(async () => {
        const value = await Modal.prompt(
            t('settingsMods.chatHistoryLimit'),
            t('settingsMods.chatHistoryLimitDescription'),
            {
                defaultValue: chatHistoryLimit != null ? String(chatHistoryLimit) : '',
                placeholder: t('settingsMods.chatHistoryLimitPlaceholder'),
            }
        );
        if (value === null) return;
        const trimmed = value.trim();
        if (trimmed === '') {
            setChatHistoryLimit(null);
        } else {
            const parsed = parseInt(trimmed, 10);
            if (!isNaN(parsed) && parsed > 0) {
                setChatHistoryLimit(parsed);
            }
        }
    }, [chatHistoryLimit, setChatHistoryLimit]);

    const limitDetail = chatHistoryLimit != null
        ? t('settingsMods.chatHistoryLimitValue', { count: chatHistoryLimit })
        : t('settingsMods.chatHistoryLimitOff');

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup title={t('settingsMods.mod01Title')} footer={t('settingsMods.mod01Description')}>
                <Item
                    title="Microphone entitlement added"
                    showChevron={false}
                />
            </ItemGroup>

            <ItemGroup title={t('settingsMods.mod02Title')} footer={t('settingsMods.mod02Description')}>
                <Item
                    title={t('settingsMods.enabled')}
                    rightElement={<Switch value={!!modXhighEnabled} onValueChange={setModXhighEnabled} />}
                    onPress={() => setModXhighEnabled(!modXhighEnabled)}
                    showChevron={false}
                />
            </ItemGroup>

            <ItemGroup title={t('settingsMods.mod04Title')} footer={t('settingsMods.mod04Description')}>
                <Item
                    title={t('settingsMods.enabled')}
                    rightElement={<Switch value={!!modHideModesEnabled} onValueChange={setModHideModesEnabled} />}
                    onPress={() => setModHideModesEnabled(!modHideModesEnabled)}
                    showChevron={false}
                />
            </ItemGroup>

            <ItemGroup title={t('settingsMods.mod05Title')} footer={t('settingsMods.mod05Description')}>
                <Item
                    title={t('settingsMods.chatHistoryLimit')}
                    icon={<Ionicons name="chatbubbles-outline" size={29} color="#007AFF" />}
                    detail={limitDetail}
                    onPress={handleChatHistoryLimit}
                />
            </ItemGroup>

            <ItemGroup title={t('settingsMods.mod06Title')} footer={t('settingsMods.mod06Description')}>
                <Item
                    title={t('settingsMods.enabled')}
                    rightElement={<Switch value={!!modDoubleTapEnabled} onValueChange={setModDoubleTapEnabled} />}
                    onPress={() => setModDoubleTapEnabled(!modDoubleTapEnabled)}
                    showChevron={false}
                />
            </ItemGroup>

            <ItemGroup title={t('settingsMods.mod07Title')} footer={t('settingsMods.mod07Description')}>
                <Item
                    title={t('settingsMods.enabled')}
                    rightElement={<Switch value={!!modReadOpenFileEnabled} onValueChange={setModReadOpenFileEnabled} />}
                    onPress={() => setModReadOpenFileEnabled(!modReadOpenFileEnabled)}
                    showChevron={false}
                />
            </ItemGroup>
        </ItemList>
    );
});
