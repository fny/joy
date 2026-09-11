import * as React from 'react';
import { View, Text, TextInput, Platform, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { RoundButton } from '@/components/RoundButton';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { checkRelay, normalizeRelayInput } from '@/auth/relayCheck';
import { switchRelayAndReload } from '@/sync/relaySwitch';
import { getServerUrl, relayNameForUrl } from '@/sync/serverConfig';

/** The welcome screen's first step: which relay. There is no built-in one —
 *  the relay is checked (a gated relay asks for its access key), saved, and
 *  the app reloads so everything binds to it. */
export function RelayStep() {
    const { theme } = useUnistyles();
    const [input, setInput] = React.useState('');
    const [error, setError] = React.useState<string | null>(null);
    const [checking, setChecking] = React.useState(false);

    const submit = React.useCallback(async () => {
        const url = normalizeRelayInput(input);
        if (!url) { setError(t('welcome.relayRequired')); return; }
        setChecking(true);
        setError(null);
        try {
            const problem = await checkRelay(url);
            if (problem) { setError(problem); return; }
            await switchRelayAndReload(url);
        } finally {
            setChecking(false);
        }
    }, [input]);

    return (
        <View style={styles.container}>
            <Text style={styles.label}>{t('welcome.relayLabel')}</Text>
            <TextInput
                value={input}
                onChangeText={(v) => { setInput(v); setError(null); }}
                onSubmitEditing={() => void submit()}
                placeholder={t('welcome.relayPlaceholder')}
                placeholderTextColor={theme.colors.input.placeholder}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                editable={!checking}
                style={[styles.input, Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : null]}
            />
            {error ? <Text style={styles.error}>{error}</Text> : <Text style={styles.hint}>{t('welcome.relayHint')}</Text>}
            <RoundButton title={checking ? t('server.validating') : t('welcome.relayContinue')} onPress={() => void submit()} loading={checking} disabled={checking} />
        </View>
    );
}

/** Under the sign-in buttons: which relay they will use, and a way back to
 *  the relay step (only offered while signed out — there is nothing to lose). */
export function RelayLine() {
    const url = getServerUrl();
    if (!url) return null;
    return (
        <Pressable onPress={() => void switchRelayAndReload(null)} hitSlop={8} accessibilityRole="button" style={(p) => [styles.line, { opacity: p.pressed ? 0.6 : 1 }]}>
            <Text style={styles.lineText}>{t('welcome.relayCurrent', { relay: relayNameForUrl(url) })}</Text>
        </Pressable>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: { maxWidth: 320, width: '100%', gap: 10 },
    label: { ...Typography.default('semiBold'), fontSize: 12, letterSpacing: 0.5, textTransform: 'uppercase', color: theme.colors.textSecondary },
    input: {
        backgroundColor: theme.colors.input.background, color: theme.colors.input.text,
        paddingHorizontal: 12, paddingVertical: 12, borderRadius: 8, fontSize: 15, ...Typography.mono(),
    },
    hint: { ...Typography.default(), fontSize: 13, color: theme.colors.textSecondary },
    error: { ...Typography.default(), fontSize: 13, color: theme.colors.textDestructive },
    line: { marginTop: 20, paddingVertical: 6 },
    lineText: { ...Typography.default(), fontSize: 13, color: theme.colors.textSecondary, textAlign: 'center' },
}));
