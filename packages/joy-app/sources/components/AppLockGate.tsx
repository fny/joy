import * as React from 'react';
import { View, Text, Pressable, Platform, AppState } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';
import { useLocalSetting } from '@/sync/storage';
import { JoyLogoType } from '@/components/JoyLogotype';
import { t } from '@/text';

// Native-only app lock (the appLock local setting): an opaque cover blocks the
// UI on cold start and whenever the app returns from BACKGROUND, until Face
// ID / Touch ID / the device passcode succeeds. disableDeviceFallback:false
// gives the "or PIN" path via the OS passcode sheet — no bespoke PIN store.
// Locking keys off 'background', NOT 'inactive': the Face ID prompt itself
// flips the app to inactive, so keying off inactive would re-lock mid-auth.
// Web/desktop has no LocalAuthentication surface — the gate is a no-op there.
export const AppLockGate = React.memo(function AppLockGate() {
    const enabled = useLocalSetting('appLock');
    const native = Platform.OS !== 'web';
    const [locked, setLocked] = React.useState(() => native && enabled);
    const authInFlight = React.useRef(false);

    // Turning the setting on arms the NEXT lock; it doesn't lock you out of
    // the settings screen you're standing on.
    React.useEffect(() => {
        if (!enabled) setLocked(false);
    }, [enabled]);

    React.useEffect(() => {
        if (!native || !enabled) return;
        const sub = AppState.addEventListener('change', (state) => {
            if (state === 'background') setLocked(true);
        });
        return () => sub.remove();
    }, [native, enabled]);

    const unlock = React.useCallback(async () => {
        if (authInFlight.current) return;
        authInFlight.current = true;
        try {
            const res = await LocalAuthentication.authenticateAsync({
                promptMessage: t('appLock.prompt'),
                disableDeviceFallback: false,
                cancelLabel: t('common.cancel'),
            });
            if (res.success) setLocked(false);
        } catch { /* stay locked; the button retries */ }
        finally { authInFlight.current = false; }
    }, []);

    // Auto-prompt when the cover appears AND the app is foregrounded (a
    // prompt fired while still backgrounded silently fails on iOS).
    React.useEffect(() => {
        if (!locked) return;
        if (AppState.currentState === 'active') void unlock();
        const sub = AppState.addEventListener('change', (state) => {
            if (state === 'active') void unlock();
        });
        return () => sub.remove();
    }, [locked, unlock]);

    if (!native || !enabled || !locked) return null;
    return (
        <View style={styles.cover}>
            <JoyLogoType size={10} />
            <Pressable onPress={() => void unlock()} style={styles.unlockBtn} hitSlop={10}>
                <Ionicons name="lock-closed-outline" size={18} color="#FFFFFF" />
                <Text style={styles.unlockText}>{t('appLock.unlock')}</Text>
            </Pressable>
        </View>
    );
});

const styles = StyleSheet.create((theme, runtime) => ({
    cover: {
        ...StyleSheet.absoluteFillObject as any,
        zIndex: 10000,
        elevation: 10000,
        backgroundColor: theme.colors.groupped.background,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 28,
        paddingBottom: runtime.insets.bottom,
    },
    unlockBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: theme.colors.textLink,
        borderRadius: 22,
        paddingHorizontal: 20,
        paddingVertical: 11,
    },
    unlockText: {
        color: '#FFFFFF',
        fontSize: 15,
        fontWeight: '600',
    },
}));
