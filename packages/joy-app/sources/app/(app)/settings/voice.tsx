import React from 'react';
import { Pressable, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Switch } from '@/components/Switch';
import { useSettingMutable } from '@/sync/storage';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { Linking } from 'react-native';
import { router } from 'expo-router';
import { Modal } from '@/modal';
import { endVoice } from '@/realtime/RealtimeSession';

const voices = ['alba', 'marius', 'javert', 'fantine', 'eponine', 'azelma'] as const;

export default React.memo(function VoiceSettingsScreen() {
    const { theme } = useUnistyles();
    const [apiStyle, setApiStyle] = useSettingMutable('voiceApiStyle');
    const [apiBaseUrl, setApiBaseUrl] = useSettingMutable('voiceApiBaseUrl');
    const [apiModel, setApiModel] = useSettingMutable('voiceApiModel');
    const [apiKey, setApiKey] = useSettingMutable('voiceApiKey');
    const [sttBaseUrl, setSttBaseUrl] = useSettingMutable('voiceSttBaseUrl');
    const [sttModel, setSttModel] = useSettingMutable('voiceSttModel');
    const [sttApiKey, setSttApiKey] = useSettingMutable('voiceSttApiKey');
    const [voice, setVoice] = useSettingMutable('pocketTtsVoice');
    const [mode, setMode] = useSettingMutable('voiceMode');
    const [wakeOnEvents, setWakeOnEvents] = useSettingMutable('voiceWakeOnEvents');
    const [wakeOnSound, setWakeOnSound] = useSettingMutable('voiceWakeOnSound');
    const [idleTimeout, setIdleTimeout] = useSettingMutable('voiceIdleTimeoutSec');

    const apiKeySet = !!apiKey;
    const sttKeySet = !!sttApiKey;
    const configChange = React.useCallback(() => { void endVoice(); }, []);

    const promptValue = React.useCallback(async (
        title: string,
        message: string,
        current: string,
        placeholder: string,
        save: (value: string) => void,
    ) => {
        const value = await Modal.prompt(title, message, { defaultValue: current, placeholder });
        if (value === null || value.trim() === current) return;
        configChange();
        save(value.trim());
    }, [configChange]);

    const setApiKeyFromPrompt = React.useCallback(async () => {
        const value = await Modal.prompt(
            t('voiceConfiguration.modelKey'),
            t('voiceConfiguration.keyPrompt'),
            { inputType: 'secure-text', placeholder: t('voiceConfiguration.keyPlaceholder') },
        );
        if (value === null) return;
        configChange();
        setApiKey(value.trim());
    }, [configChange, setApiKey]);

    const setSttKeyFromPrompt = React.useCallback(async () => {
        const value = await Modal.prompt(
            t('voiceConfiguration.sttKey'),
            t('voiceConfiguration.keyPrompt'),
            { inputType: 'secure-text', placeholder: t('voiceConfiguration.keyPlaceholder') },
        );
        if (value === null) return;
        configChange();
        setSttApiKey(value.trim());
    }, [configChange, setSttApiKey]);

    const keyRow = (title: string, isSet: boolean, onSet: () => void, onClear: () => void) => (
        <Item
            title={title}
            subtitle={isSet ? t('voiceConfiguration.keySet') : t('voiceConfiguration.keyMissing')}
            rightElement={isSet ? (
                <Pressable onPress={onClear} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('voiceConfiguration.clearKey')}>
                    <Ionicons name="close-circle" size={22} color={theme.colors.textSecondary} />
                </Pressable>
            ) : undefined}
            onPress={onSet}
        />
    );

    const timeoutLabel = idleTimeout === 0 ? t('voiceConfiguration.never') : t('voiceConfiguration.seconds', { seconds: idleTimeout });

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup title={t('voiceConfiguration.conversationTitle')} footer={t('voiceConfiguration.conversationFooter')}>
                <Item title={t('voiceConfiguration.apiStyle')} subtitle={t('voiceConfiguration.apiStyleSubtitle')} showChevron={false} />
                {(['openai', 'anthropic'] as const).map(style => (
                    <Item key={style}
                        title={style === 'openai' ? t('voiceConfiguration.openaiCompatible') : t('voiceConfiguration.anthropicCompatible')}
                        rightElement={apiStyle === style ? <Ionicons name="checkmark" size={20} color={theme.colors.textLink} /> : undefined}
                        showChevron={false}
                        onPress={() => {
                            if (apiStyle === style) return;
                            configChange();
                            setApiStyle(style);
                            if (['https://api.openai.com/v1', 'https://api.anthropic.com/v1'].includes(apiBaseUrl)) {
                                setApiBaseUrl(style === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com/v1');
                            }
                            setApiModel('');
                            setApiKey('');
                        }} />
                ))}
                <Item title={t('voiceConfiguration.modelEndpoint')} subtitle={apiBaseUrl} onPress={() => { void promptValue(t('voiceConfiguration.modelEndpoint'), t('voiceConfiguration.endpointPrompt'), apiBaseUrl, 'https://api.openai.com/v1', value => { setApiBaseUrl(value); setApiKey(''); }); }} />
                <Item title={t('voiceConfiguration.model')} subtitle={apiModel || t('voiceConfiguration.modelMissing')} onPress={() => { void promptValue(t('voiceConfiguration.model'), t('voiceConfiguration.modelPrompt'), apiModel, t('voiceConfiguration.modelPlaceholder'), setApiModel); }} />
                {keyRow(t('voiceConfiguration.modelKey'), apiKeySet, () => { void setApiKeyFromPrompt(); }, () => { configChange(); setApiKey(''); })}
            </ItemGroup>

            <ItemGroup title={t('voiceConfiguration.transcriptionTitle')} footer={t('voiceConfiguration.transcriptionFooter')}>
                <Item title={t('voiceConfiguration.sttEndpoint')} subtitle={sttBaseUrl} onPress={() => { void promptValue(t('voiceConfiguration.sttEndpoint'), t('voiceConfiguration.endpointPrompt'), sttBaseUrl, 'https://api.openai.com/v1', value => { setSttBaseUrl(value); setSttApiKey(''); }); }} />
                <Item title={t('voiceConfiguration.sttModel')} subtitle={sttModel || t('voiceConfiguration.modelMissing')} onPress={() => { void promptValue(t('voiceConfiguration.sttModel'), t('voiceConfiguration.sttModelPrompt'), sttModel, 'whisper-1', setSttModel); }} />
                {keyRow(t('voiceConfiguration.sttKey'), sttKeySet, () => { void setSttKeyFromPrompt(); }, () => { configChange(); setSttApiKey(''); })}
            </ItemGroup>

            <ItemGroup title={t('voiceConfiguration.conversationMode')}>
                <Item title={t('voiceConfiguration.staysOn')} subtitle={t('voiceConfiguration.staysOnSubtitle')}
                    rightElement={mode === 'classic' ? <Ionicons name="checkmark" size={20} color={theme.colors.textLink} /> : undefined}
                    showChevron={false} onPress={() => { configChange(); setMode('classic'); }} />
                <Item title={t('voiceConfiguration.standby')} subtitle={t('voiceConfiguration.standbySubtitle')}
                    rightElement={mode === 'standby' ? <Ionicons name="checkmark" size={20} color={theme.colors.textLink} /> : undefined}
                    showChevron={false} onPress={() => { configChange(); setMode('standby'); }} />
                {mode === 'standby' && <>
                    <Item title={t('voiceConfiguration.wakeOnEvents')} subtitle={t('voiceConfiguration.wakeOnEventsSubtitle')} showChevron={false}
                        rightElement={<Switch value={wakeOnEvents} onValueChange={value => { configChange(); setWakeOnEvents(value); }} />} />
                    <Item title={t('voiceConfiguration.wakeOnSound')} subtitle={t('voiceConfiguration.wakeOnSoundSubtitle')} showChevron={false}
                        rightElement={<Switch value={wakeOnSound} onValueChange={value => { configChange(); setWakeOnSound(value); }} />} />
                    <Item title={t('voiceConfiguration.idleTimeout')} detail={timeoutLabel} onPress={async () => {
                        const value = await Modal.prompt(t('voiceConfiguration.idleTimeout'), t('voiceConfiguration.idleTimeoutPrompt'), { defaultValue: String(idleTimeout), placeholder: '0', inputType: 'numeric' });
                        if (value === null) return;
                        const seconds = Number(value);
                        if (Number.isFinite(seconds) && seconds >= 0) { configChange(); setIdleTimeout(Math.floor(seconds)); }
                    }} />
                </>}
            </ItemGroup>

            <ItemGroup title={t('voiceConfiguration.playbackTitle')} footer={t('voiceConfiguration.playbackFooter')}>
                {voices.map(name => (
                    <Item key={name} title={name[0].toUpperCase() + name.slice(1)}
                        rightElement={(voice === 'jean' || voice === 'cosette' ? 'alba' : voice) === name ? <Ionicons name="checkmark" size={20} color={theme.colors.textLink} /> : undefined}
                        showChevron={false} onPress={() => { configChange(); setVoice(name); }} />
                ))}
                <Item title={t('pocketVoice.setupInstructions')} titleStyle={{ fontSize: 13 }} showChevron={false} />
                <Item title="Pocket TTS — Kyutai · CC BY 4.0" onPress={() => { void Linking.openURL('https://huggingface.co/kyutai/pocket-tts'); }} />
                <Item title={t('pocketVoice.licenses')} onPress={() => { router.push('/settings/voice-licenses'); }} />
            </ItemGroup>

            <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 20 }}>
                <Text style={{ color: theme.colors.textSecondary, fontSize: 13, lineHeight: 19 }}>{t('voiceConfiguration.privacy')}</Text>
            </View>
        </ItemList>
    );
});
