/**
 * Voice settings: the ElevenLabs agents the user brought (public = agent id
 * alone; private = agent id + API key), which one is in use, and the
 * standing-by behavior (event wake, idle hang-up).
 */
import React from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { randomUUID } from 'expo-crypto';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Switch } from '@/components/Switch';
import { useSettingMutable } from '@/sync/storage';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useUnistyles } from 'react-native-unistyles';
import type { Settings } from '@/sync/settings';

type VoiceAgent = Settings['voiceAgents'][number];

export default React.memo(function VoiceSettingsScreen() {
    const { theme } = useUnistyles();
    const [agents, setAgents] = useSettingMutable('voiceAgents');
    const [activeAgentId, setActiveAgentId] = useSettingMutable('voiceActiveAgentId');
    const [wakeOnEvents, setWakeOnEvents] = useSettingMutable('voiceWakeOnEvents');
    const [idleTimeoutSec, setIdleTimeoutSec] = useSettingMutable('voiceIdleTimeoutSec');

    const activeId = agents.find(a => a.id === activeAgentId)?.id ?? agents[0]?.id ?? null;

    const updateAgent = React.useCallback((id: string, patch: Partial<VoiceAgent>) => {
        setAgents(agents.map(a => (a.id === id ? { ...a, ...patch } : a)));
    }, [agents, setAgents]);

    const handleAdd = React.useCallback(async () => {
        const name = await Modal.prompt(t('settingsVoice.addAgent'), t('settingsVoice.addAgentName'), {
            placeholder: t('settingsVoice.addAgentNamePlaceholder'),
        });
        if (name === null) return;
        const agentId = await Modal.prompt(t('settingsVoice.addAgent'), t('settingsVoice.addAgentId'), {
            placeholder: t('settingsVoice.addAgentIdPlaceholder'),
        });
        if (agentId === null || !agentId.trim()) return;
        const apiKey = await Modal.prompt(t('settingsVoice.addAgent'), t('settingsVoice.addAgentKeyMessage'), {
            placeholder: t('settingsVoice.addAgentKey'),
            inputType: 'secure-text',
        });
        if (apiKey === null) return;
        const agent: VoiceAgent = {
            id: randomUUID(),
            name: name.trim() || agentId.trim(),
            agentId: agentId.trim(),
            apiKey: apiKey.trim() || null,
        };
        setAgents([...agents, agent]);
        if (!activeId) setActiveAgentId(agent.id);
    }, [agents, activeId, setAgents, setActiveAgentId]);

    const handleAgentPress = React.useCallback((agent: VoiceAgent) => {
        Modal.alert(agent.name, agent.agentId, [
            { text: t('settingsVoice.use'), onPress: () => setActiveAgentId(agent.id) },
            {
                text: t('settingsVoice.rename'),
                onPress: async () => {
                    const name = await Modal.prompt(t('settingsVoice.rename'), undefined, { defaultValue: agent.name });
                    if (name !== null && name.trim()) updateAgent(agent.id, { name: name.trim() });
                },
            },
            {
                text: agent.apiKey ? t('settingsVoice.replaceKey') : t('settingsVoice.setKey'),
                onPress: async () => {
                    const key = await Modal.prompt(t('settingsVoice.setKey'), t('settingsVoice.addAgentKeyMessage'), {
                        placeholder: t('settingsVoice.addAgentKey'),
                        inputType: 'secure-text',
                    });
                    if (key !== null) updateAgent(agent.id, { apiKey: key.trim() || null });
                },
            },
            {
                text: t('settingsVoice.remove'),
                style: 'destructive',
                onPress: async () => {
                    const ok = await Modal.confirm(t('settingsVoice.remove'), t('settingsVoice.removeConfirm', { name: agent.name }), {
                        confirmText: t('settingsVoice.remove'),
                        destructive: true,
                    });
                    if (!ok) return;
                    const next = agents.filter(a => a.id !== agent.id);
                    setAgents(next);
                    if (activeAgentId === agent.id) setActiveAgentId(next[0]?.id ?? null);
                },
            },
            { text: t('common.cancel'), style: 'cancel' },
        ]);
    }, [agents, activeAgentId, setAgents, setActiveAgentId, updateAgent]);

    const handleIdleTimeout = React.useCallback(async () => {
        const value = await Modal.prompt(t('settingsVoice.idleTimeout'), t('settingsVoice.idleTimeoutPrompt'), {
            defaultValue: String(idleTimeoutSec),
            inputType: 'numeric',
        });
        if (value === null) return;
        const n = parseInt(value.trim(), 10);
        if (!isNaN(n) && n >= 0) setIdleTimeoutSec(n);
    }, [idleTimeoutSec, setIdleTimeoutSec]);

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup title={t('settingsVoice.agentsTitle')} footer={t('settingsVoice.agentsFooter')}>
                {agents.length === 0 && (
                    <Item title={t('settingsVoice.noAgents')} showChevron={false} />
                )}
                {agents.map(agent => (
                    <Item
                        key={agent.id}
                        title={agent.name}
                        subtitle={agent.apiKey ? t('settingsVoice.privateAgent') : t('settingsVoice.publicAgent')}
                        detail={agent.id === activeId ? t('settingsVoice.inUse') : undefined}
                        icon={<Ionicons name={agent.apiKey ? 'lock-closed-outline' : 'globe-outline'} size={29} color={agent.id === activeId ? theme.colors.accents.green : theme.colors.textSecondary} />}
                        onPress={() => handleAgentPress(agent)}
                    />
                ))}
                <Item
                    title={t('settingsVoice.addAgent')}
                    icon={<Ionicons name="add-circle-outline" size={29} color={theme.colors.accents.blue} />}
                    onPress={handleAdd}
                />
            </ItemGroup>

            <ItemGroup title={t('settingsVoice.behaviorTitle')}>
                <Item
                    title={t('settingsVoice.wakeOnEvents')}
                    subtitle={t('settingsVoice.wakeOnEventsSubtitle')}
                    subtitleLines={0}
                    icon={<Ionicons name="notifications-outline" size={29} color={theme.colors.accents.orange} />}
                    rightElement={<Switch value={wakeOnEvents} onValueChange={setWakeOnEvents} />}
                    showChevron={false}
                />
                <Item
                    title={t('settingsVoice.idleTimeout')}
                    subtitle={t('settingsVoice.idleTimeoutSubtitle', { seconds: idleTimeoutSec })}
                    icon={<Ionicons name="timer-outline" size={29} color={theme.colors.accents.indigo} />}
                    onPress={handleIdleTimeout}
                />
            </ItemGroup>

            <ItemGroup title={t('settingsVoice.setupTitle')}>
                <Item
                    title={t('settingsVoice.setupFooter')}
                    titleStyle={{ fontSize: 13 }}
                    showChevron={false}
                    copy={t('settingsVoice.setupFooter')}
                />
            </ItemGroup>
        </ItemList>
    );
});
