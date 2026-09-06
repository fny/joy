import { Platform, Pressable, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable, useLocalSettingMutable } from '@/sync/storage';
import { Switch } from '@/components/Switch';
import { Modal } from '@/modal';
import { t } from '@/text';
import { limitFromPromptValue } from '@/utils/limitPrompt';

export default function FeaturesSettingsScreen() {
    const { theme } = useUnistyles();
    const [agentInputEnterToSend, setAgentInputEnterToSend] = useSettingMutable('agentInputEnterToSend');
    const [commandPaletteEnabled, setCommandPaletteEnabled] = useLocalSettingMutable('commandPaletteEnabled');
    const [markdownCopyV2, setMarkdownCopyV2] = useLocalSettingMutable('markdownCopyV2');
    const [limitSessionMemory, setLimitSessionMemory] = useLocalSettingMutable('limitSessionMemory');
    const [hideInactiveSessions, setHideInactiveSessions] = useSettingMutable('hideInactiveSessions');
    const [fileDiffsSidebar, setFileDiffsSidebar] = useSettingMutable('fileDiffsSidebar');
    const [groupToolCalls, setGroupToolCalls] = useSettingMutable('groupToolCalls');
    // Joy-specific toggles (relocated from the mods page). Plain strings — these
    // are personal-build features, matching the other plain-string rows above.
    const [chatHistoryLimit, setChatHistoryLimit] = useSettingMutable('joy__chatHistoryLimit');
    const [doubleTapEnabled, setDoubleTapEnabled] = useSettingMutable('joy__doubleTapEnabled');

    const handleChatHistoryLimit = async () => {
        const value = await Modal.prompt(
            'Chat history limit',
            'Max messages rendered per conversation. Empty to disable.',
            {
                defaultValue: chatHistoryLimit != null ? String(chatHistoryLimit) : '',
                placeholder: 'e.g. 100',
            }
        );
        const next = limitFromPromptValue(value);
        if (next.change) setChatHistoryLimit(next.limit);
    };

    const handleLimitSessionMemory = async () => {
        const value = await Modal.prompt(
            t('settingsFeatures.limitSessionMemory'),
            t('settingsFeatures.limitSessionMemoryMessage'),
            {
                defaultValue: limitSessionMemory != null ? String(limitSessionMemory) : '',
                placeholder: t('settingsFeatures.limitSessionMemoryPlaceholder'),
            }
        );
        const next = limitFromPromptValue(value);
        if (next.change) setLimitSessionMemory(next.limit);
    };

    // Explicit "turn off" affordance for a set limit — independent of how the
    // platform prompt reports an emptied field (#176).
    // Item hides `detail` when a rightElement is given, so the value rides
    // along inside the element.
    const limitWithClear = (value: string, label: string, onClear: () => void) => (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={{ fontSize: 17, color: theme.colors.textSecondary }}>{value}</Text>
            <Pressable
                onPress={onClear}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel={label}
                style={({ pressed }) => [{ padding: 2 }, pressed && { opacity: 0.5 }]}
            >
                <Ionicons name="close-circle" size={22} color={theme.colors.textSecondary} />
            </Pressable>
        </View>
    );

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {/* Interface */}
            <ItemGroup
                title="Interface"
                footer="Optional panels and layout elements."
            >
                <Item
                    title="File Diffs Sidebar"
                    subtitle="Show git changes next to the chat on desktop"
                    icon={<Ionicons name="git-branch-outline" size={29} color="#5AC8FA" />}
                    rightElement={
                        <Switch
                            value={fileDiffsSidebar}
                            onValueChange={setFileDiffsSidebar}
                        />
                    }
                    showChevron={false}
                />
                <Item
                    title={t('settingsFeatures.groupToolCalls')}
                    subtitle={t('settingsFeatures.groupToolCallsSubtitle')}
                    icon={<Ionicons name="layers-outline" size={29} color="#AF52DE" />}
                    rightElement={
                        <Switch
                            value={groupToolCalls}
                            onValueChange={setGroupToolCalls}
                        />
                    }
                    showChevron={false}
                />
            </ItemGroup>

            {/* Joy — personal-build toggles (relocated from the mods page) */}
            <ItemGroup
                title="Joy"
                footer="Personal-build behaviour toggles."
            >
                <Item
                    title="Chat history limit"
                    subtitle="Caps messages rendered per conversation"
                    icon={<Ionicons name="filter-outline" size={29} color="#5AC8FA" />}
                    detail={chatHistoryLimit != null ? `${chatHistoryLimit}` : 'off'}
                    onPress={handleChatHistoryLimit}
                    rightElement={chatHistoryLimit != null ? limitWithClear(String(chatHistoryLimit), 'Turn off chat history limit', () => setChatHistoryLimit(null)) : undefined}
                />
                <Item
                    title="Double tap"
                    subtitle="Second tap within 2s required to commit choice selections"
                    icon={<Ionicons name="finger-print-outline" size={29} color="#FF9500" />}
                    rightElement={
                        <Switch
                            value={!!doubleTapEnabled}
                            onValueChange={setDoubleTapEnabled}
                        />
                    }
                    showChevron={false}
                />
            </ItemGroup>

            {/* Experimental Features */}
            <ItemGroup
                title={t('settingsFeatures.experiments')}
                footer={t('settingsFeatures.experimentsDescription')}
            >
                <Item
                    title={t('settingsFeatures.markdownCopyV2')}
                    subtitle={t('settingsFeatures.markdownCopyV2Subtitle')}
                    icon={<Ionicons name="text-outline" size={29} color="#34C759" />}
                    rightElement={
                        <Switch
                            value={markdownCopyV2}
                            onValueChange={setMarkdownCopyV2}
                        />
                    }
                    showChevron={false}
                />
                <Item
                    title={t('settingsFeatures.hideInactiveSessions')}
                    subtitle={t('settingsFeatures.hideInactiveSessionsSubtitle')}
                    icon={<Ionicons name="eye-off-outline" size={29} color="#FF9500" />}
                    rightElement={
                        <Switch
                            value={hideInactiveSessions}
                            onValueChange={setHideInactiveSessions}
                        />
                    }
                    showChevron={false}
                />
                <Item
                    title={t('settingsFeatures.limitSessionMemory')}
                    subtitle={t('settingsFeatures.limitSessionMemorySubtitle')}
                    icon={<Ionicons name="hardware-chip-outline" size={29} color="#34C759" />}
                    detail={limitSessionMemory != null ? String(limitSessionMemory) : t('settingsFeatures.limitSessionMemoryAll')}
                    onPress={handleLimitSessionMemory}
                    rightElement={limitSessionMemory != null ? limitWithClear(String(limitSessionMemory), t('settingsFeatures.limitSessionMemoryAll'), () => setLimitSessionMemory(null)) : undefined}
                />
            </ItemGroup>

            {/* Web-only Features */}
            {Platform.OS === 'web' && (
                <ItemGroup 
                    title={t('settingsFeatures.webFeatures')}
                    footer={t('settingsFeatures.webFeaturesDescription')}
                >
                    <Item
                        title={t('settingsFeatures.enterToSend')}
                        subtitle={agentInputEnterToSend ? t('settingsFeatures.enterToSendEnabled') : t('settingsFeatures.enterToSendDisabled')}
                        icon={<Ionicons name="return-down-forward-outline" size={29} color="#007AFF" />}
                        rightElement={
                            <Switch
                                value={agentInputEnterToSend}
                                onValueChange={setAgentInputEnterToSend}
                            />
                        }
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsFeatures.commandPalette')}
                        subtitle={commandPaletteEnabled ? t('settingsFeatures.commandPaletteEnabled') : t('settingsFeatures.commandPaletteDisabled')}
                        icon={<Ionicons name="keypad-outline" size={29} color="#007AFF" />}
                        rightElement={
                            <Switch
                                value={commandPaletteEnabled}
                                onValueChange={setCommandPaletteEnabled}
                            />
                        }
                        showChevron={false}
                    />
                </ItemGroup>
            )}
        </ItemList>
    );
}
