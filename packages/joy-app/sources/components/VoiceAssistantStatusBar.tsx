/**
 * Voice status strip under the chat header (phone) or in the sidebar
 * (tablet/desktop). Three states: connecting, live, standing by (armed but
 * hung up). Tap toggles live ↔ standing by; the × ends voice for good.
 */
import * as React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useRealtimeStatus, useRealtimeMode, useVoiceArmedSessionId } from '@/sync/storage';
import { StatusDot } from './StatusDot';
import { Typography } from '@/constants/Typography';
import Ionicons from '@expo/vector-icons/Ionicons';
import { endVoice, hangUp, startVoice } from '@/realtime/RealtimeSession';
import { useUnistyles } from 'react-native-unistyles';
import { VoiceBars } from './VoiceBars';
import { t } from '@/text';

interface VoiceAssistantStatusBarProps {
    variant?: 'full' | 'sidebar';
    style?: any;
}

export const VoiceAssistantStatusBar = React.memo(({ variant = 'full', style }: VoiceAssistantStatusBarProps) => {
    const { theme } = useUnistyles();
    const realtimeStatus = useRealtimeStatus();
    const realtimeMode = useRealtimeMode();
    const armedSessionId = useVoiceArmedSessionId();

    if (realtimeStatus === 'disconnected' && armedSessionId === null) {
        return null;
    }

    const isSpeaking = realtimeStatus === 'connected' && (realtimeMode === 'agent-speaking' || realtimeMode === 'user-speaking');

    let color: string;
    let pulsing = false;
    let text: string;
    let hint: string;
    switch (realtimeStatus) {
        case 'connecting':
            color = theme.colors.status.connecting; pulsing = true;
            text = t('voice.statusConnecting'); hint = '';
            break;
        case 'connected':
            color = theme.colors.status.connected;
            text = t('voice.statusLive'); hint = t('voice.tapToPause');
            break;
        case 'error':
            color = theme.colors.status.error;
            text = t('voice.statusError'); hint = t('voice.tapToTalk');
            break;
        default:
            color = theme.colors.status.default;
            text = t('voice.statusArmed'); hint = t('voice.tapToTalk');
    }

    const handlePress = () => {
        if (realtimeStatus === 'connecting') return;
        if (realtimeStatus === 'connected') { void hangUp(); return; }
        if (armedSessionId) void startVoice(armedSessionId);
    };
    const handleEnd = () => { void endVoice(); };

    const isFull = variant === 'full';
    return (
        <View style={[styles.container, { backgroundColor: theme.colors.surfaceHighest }, style]}>
            <Pressable onPress={handlePress} style={styles.pressable} hitSlop={6}>
                <View style={styles.content}>
                    <View style={styles.leftSection}>
                        <StatusDot color={color} isPulsing={pulsing} size={8} style={styles.statusDot} />
                        <Ionicons name={realtimeStatus === 'connected' ? 'mic' : 'mic-outline'} size={16} color={theme.colors.text} style={styles.micIcon} />
                        <Text style={[styles.statusText, !isFull && styles.sidebarStatusText, { color: theme.colors.text }]} numberOfLines={1}>
                            {text}
                        </Text>
                    </View>
                    <View style={styles.rightSection}>
                        {isSpeaking && <VoiceBars isActive color={theme.colors.text} size="small" />}
                        {isFull && !!hint && (
                            <Text style={[styles.hintText, { color: theme.colors.textSecondary, marginLeft: isSpeaking ? 8 : 0 }]}>{hint}</Text>
                        )}
                    </View>
                </View>
            </Pressable>
            <Pressable onPress={handleEnd} hitSlop={8} style={styles.endButton} accessibilityLabel={t('voice.end')}>
                <Ionicons name="close" size={16} color={theme.colors.textSecondary} />
            </Pressable>
        </View>
    );
});

const styles = StyleSheet.create({
    container: {
        height: 32,
        width: '100%',
        flexDirection: 'row',
        alignItems: 'center',
    },
    pressable: {
        flex: 1,
        height: '100%',
        justifyContent: 'center',
    },
    content: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingLeft: 12,
        paddingRight: 4,
    },
    leftSection: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 1,
    },
    rightSection: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    statusDot: { marginRight: 6 },
    micIcon: { marginRight: 6 },
    statusText: {
        fontSize: 14,
        fontWeight: '500',
        ...Typography.default(),
    },
    sidebarStatusText: { fontSize: 12 },
    hintText: {
        fontSize: 12,
        ...Typography.default(),
    },
    endButton: {
        height: 32,
        width: 32,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
