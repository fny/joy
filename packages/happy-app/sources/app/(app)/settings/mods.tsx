import * as React from 'react';
import { Switch } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable } from '@/sync/storage';
import { Modal } from '@/modal';
import { t } from '@/text';
import { getClaudePermissionModes, getClaudeModelModes, getClaudeEffortLevels } from '@/components/modelModeOptions';

export default React.memo(function ModsSettingsScreen() {
    const [modXhighEnabled, setModXhighEnabled] = useSettingMutable('joy__xHighEnabled');
    const [modSessionDefaultsEnabled, setModSessionDefaultsEnabled] = useSettingMutable('joy__sessionDefaultsEnabled');
    const [modHideModesEnabled, setModHideModesEnabled] = useSettingMutable('joy__hideModesEnabled');

    const [defaultPermissionMode, setDefaultPermissionMode] = useSettingMutable('joy__defaultPermissionMode');
    const [defaultModelMode, setDefaultModelMode] = useSettingMutable('joy__defaultModelMode');
    const [defaultEffortLevel, setDefaultEffortLevel] = useSettingMutable('joy__defaultEffortLevel');
    const [chatHistoryLimit, setChatHistoryLimit] = useSettingMutable('joy__chatHistoryLimit');

    const permissionModes = React.useMemo(() => getClaudePermissionModes(t), []);
    const modelModes = React.useMemo(() => getClaudeModelModes(), []);
    const effortLevels = React.useMemo(() => getClaudeEffortLevels(), []);

    const handleCyclePermissionMode = React.useCallback(() => {
        const currentKey = defaultPermissionMode ?? 'default';
        const idx = permissionModes.findIndex(m => m.key === currentKey);
        setDefaultPermissionMode(permissionModes[(idx + 1) % permissionModes.length]!.key);
    }, [defaultPermissionMode, permissionModes, setDefaultPermissionMode]);

    const handleCycleModelMode = React.useCallback(() => {
        const currentKey = defaultModelMode ?? 'default';
        const idx = modelModes.findIndex(m => m.key === currentKey);
        setDefaultModelMode(modelModes[(idx + 1) % modelModes.length]!.key);
    }, [defaultModelMode, modelModes, setDefaultModelMode]);

    const handleCycleEffortLevel = React.useCallback(() => {
        const currentKey = defaultEffortLevel ?? 'high';
        const idx = effortLevels.findIndex(e => e.key === currentKey);
        setDefaultEffortLevel(effortLevels[(idx + 1) % effortLevels.length]!.key);
    }, [defaultEffortLevel, effortLevels, setDefaultEffortLevel]);

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

    const permModeDetail = permissionModes.find(m => m.key === (defaultPermissionMode ?? 'default'))?.name ?? permissionModes[0]!.name;
    const modelDetail = modelModes.find(m => m.key === (defaultModelMode ?? 'default'))?.name ?? modelModes[0]!.name;
    const effortDetail = effortLevels.find(e => e.key === (defaultEffortLevel ?? 'high'))?.name ?? 'high';
    const limitDetail = chatHistoryLimit != null
        ? t('settingsMods.chatHistoryLimitValue', { count: chatHistoryLimit })
        : t('settingsMods.chatHistoryLimitUnlimited');

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup title={t('settingsMods.mod02Title')} footer={t('settingsMods.mod02Description')}>
                <Item
                    title={t('settingsMods.enabled')}
                    rightElement={<Switch value={!!modXhighEnabled} onValueChange={setModXhighEnabled} />}
                    onPress={() => setModXhighEnabled(!modXhighEnabled)}
                    showChevron={false}
                />
            </ItemGroup>

            <ItemGroup title={t('settingsMods.mod03Title')} footer={!modSessionDefaultsEnabled ? t('settingsMods.mod03Description') : undefined}>
                <Item
                    title={t('settingsMods.enabled')}
                    rightElement={<Switch value={!!modSessionDefaultsEnabled} onValueChange={setModSessionDefaultsEnabled} />}
                    onPress={() => setModSessionDefaultsEnabled(!modSessionDefaultsEnabled)}
                    showChevron={false}
                />
                {!!modSessionDefaultsEnabled && (
                    <>
                        <Item
                            title={t('settingsMods.defaultPermMode')}
                            subtitle={t('settingsMods.defaultPermModeDescription')}
                            icon={<Ionicons name="shield-outline" size={29} color="#34C759" />}
                            detail={permModeDetail}
                            onPress={handleCyclePermissionMode}
                        />
                        <Item
                            title={t('settingsMods.defaultModel')}
                            subtitle={t('settingsMods.defaultModelDescription')}
                            icon={<Ionicons name="cube-outline" size={29} color="#5856D6" />}
                            detail={modelDetail}
                            onPress={handleCycleModelMode}
                        />
                        <Item
                            title={t('settingsMods.defaultEffort')}
                            subtitle={t('settingsMods.defaultEffortDescription')}
                            icon={<Ionicons name="speedometer-outline" size={29} color="#FF9500" />}
                            detail={effortDetail}
                            onPress={handleCycleEffortLevel}
                        />
                        <Item
                            title={t('settingsMods.chatHistoryLimit')}
                            subtitle={t('settingsMods.chatHistoryLimitDescription')}
                            icon={<Ionicons name="chatbubbles-outline" size={29} color="#007AFF" />}
                            detail={limitDetail}
                            onPress={handleChatHistoryLimit}
                        />
                    </>
                )}
            </ItemGroup>

            <ItemGroup title={t('settingsMods.mod04Title')} footer={t('settingsMods.mod04Description')}>
                <Item
                    title={t('settingsMods.enabled')}
                    rightElement={<Switch value={!!modHideModesEnabled} onValueChange={setModHideModesEnabled} />}
                    onPress={() => setModHideModesEnabled(!modHideModesEnabled)}
                    showChevron={false}
                />
            </ItemGroup>
        </ItemList>
    );
});
