import 'react-native-quick-base64';
import '../theme.css';
import * as React from 'react';
import * as SplashScreen from 'expo-splash-screen';
import * as Fonts from 'expo-font';
import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { AuthCredentials, TokenStorage, areCredentialsUsable } from '@/auth/tokenStorage';
import { AuthProvider } from '@/auth/AuthContext';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { initialWindowMetrics, SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SidebarNavigator } from '@/components/SidebarNavigator';
import sodium from '@/encryption/libsodium.lib';
import { View, Platform, AppState } from 'react-native';
import { ModalProvider } from '@/modal';
import { RealtimeProvider } from '@/realtime/RealtimeProvider';
import { AppLockGate } from '@/components/AppLockGate';
import { installRelayKeyFetchInterceptor } from '@/sync/serverConfig';
import { syncRestore } from '@/sync/sync';
import { FaviconPermissionIndicator } from '@/components/web/FaviconPermissionIndicator';
import { CommandPaletteProvider } from '@/components/CommandPalette/CommandPaletteProvider';
import { StatusBarProvider } from '@/components/StatusBarProvider';
import * as SystemUI from 'expo-system-ui';
import { useRootGutter } from '@/hooks/useRootGutter';
import { initConsoleLogging, setConsoleOutputEnabled } from '@/utils/consoleLogging';
import { useLocalSetting } from '@/sync/storage';
import { useUnistyles } from 'react-native-unistyles';
import { AsyncLock } from '@/utils/lock';
import { getSessionRouteFromNotificationResponse } from '@/utils/notificationRouting';
import { navigateToSession, PathnameTracker } from '@/hooks/useNavigateToSession';
import { useTauriZoom } from '@/hooks/useTauriZoom';
import { BrowserNavigationShortcuts } from '@/hooks/useBrowserNavigationShortcuts';
import { useTauriDrag } from '@/hooks/useTauriDrag';
import { preventInputZoom } from '@/utils/preventInputZoom';
import { stripDevCredentialParams } from '@/utils/devCredentialUrl';

// Mobile web: stop iOS Safari from zooming the page when small-font inputs
// gain focus. Module scope so it runs before first paint.
preventInputZoom();

// Configure notification handler — suppress push display when app is in foreground
Notifications.setNotificationHandler({
    handleNotification: async () => {
        const isForeground = AppState.currentState === 'active';
        return {
            shouldShowAlert: !isForeground,
            shouldPlaySound: !isForeground,
            shouldSetBadge: true,
            shouldShowBanner: !isForeground,
            shouldShowList: true,
        };
    },
});

// Setup Android notification channels (required for Android 8.0+)
if (Platform.OS === 'android') {
    Notifications.setNotificationChannelAsync('default', {
        name: 'Default',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#FF231F7C',
    });
    Notifications.setNotificationChannelAsync('messages', {
        name: 'Messages',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#FF231F7C',
    });
}

export {
    // Catch any errors thrown by the Layout component.
    ErrorBoundary,
} from 'expo-router';

// Configure splash screen
SplashScreen.setOptions({
    fade: true,
    duration: 300,
})
SplashScreen.preventAutoHideAsync();

// Set window background color - now handled by Unistyles
// SystemUI.setBackgroundColorAsync('white');

// Remote logging to local log server (configured via Dev > Log Server setting)
initConsoleLogging()

// Applies horizontal safe-area padding AND paints the gutters. In landscape the
// left/right insets are non-zero (notch / rounded corners); padding alone left
// the bare native window (white) showing in those strips. Background follows
// the theme, or a screen's override (e.g. the terminal pane's dark) via
// useRootGutter. The native window color is kept in sync so rotation
// transitions don't flash white either.
function HorizontalSafeAreaWrapper({ children }: { children: React.ReactNode }) {
    const insets = useSafeAreaInsets();
    const { theme } = useUnistyles();
    const override = useRootGutter((s) => s.color);
    const background = override ?? theme.colors.groupped.background;
    React.useEffect(() => {
        if (Platform.OS !== 'web') {
            void SystemUI.setBackgroundColorAsync(background).catch(() => { });
        }
    }, [background]);
    return (
        <View style={{
            flex: 1,
            paddingLeft: insets.left,
            paddingRight: insets.right,
            backgroundColor: background,
        }}>
            {children}
        </View>
    );
}

let lock = new AsyncLock();
let loaded = false;

function stringifyNotificationPayload(value: unknown): string {
    try {
        const serialized = JSON.stringify(value, null, 2);
        return serialized ?? String(value);
    } catch (error) {
        return `[unserializable notification payload: ${error instanceof Error ? error.message : 'Unknown error'}]`;
    }
}

async function loadFonts() {
    await lock.inLock(async () => {
        if (loaded) {
            return;
        }
        loaded = true;
        // Check if running in Tauri
        const isTauri = Platform.OS === 'web' &&
            typeof window !== 'undefined' &&
            (window as any).__TAURI_INTERNALS__ !== undefined;

        if (!isTauri) {
            // Normal font loading for non-Tauri environments (native and regular web)
            await Fonts.loadAsync({
                // Keep existing font
                SpaceMono: require('@/assets/fonts/SpaceMono-Regular.ttf'),

                // IBM Plex Sans family
                'IBMPlexSans-Regular': require('@/assets/fonts/IBMPlexSans-Regular.ttf'),
                'IBMPlexSans-Italic': require('@/assets/fonts/IBMPlexSans-Italic.ttf'),
                'IBMPlexSans-SemiBold': require('@/assets/fonts/IBMPlexSans-SemiBold.ttf'),

                // IBM Plex Mono family  
                'IBMPlexMono-Regular': require('@/assets/fonts/IBMPlexMono-Regular.ttf'),
                'IBMPlexMono-Italic': require('@/assets/fonts/IBMPlexMono-Italic.ttf'),
                'IBMPlexMono-SemiBold': require('@/assets/fonts/IBMPlexMono-SemiBold.ttf'),

                // Bricolage Grotesque  
                'BricolageGrotesque-Bold': require('@/assets/fonts/BricolageGrotesque-Bold.ttf'),

            });
        } else {
            // For Tauri, skip Font Face Observer as fonts are loaded via CSS
            console.log('Do not wait for fonts to load');
            (async () => {
                try {
                    await Fonts.loadAsync({
                        // Keep existing font
                        SpaceMono: require('@/assets/fonts/SpaceMono-Regular.ttf'),

                        // IBM Plex Sans family
                        'IBMPlexSans-Regular': require('@/assets/fonts/IBMPlexSans-Regular.ttf'),
                        'IBMPlexSans-Italic': require('@/assets/fonts/IBMPlexSans-Italic.ttf'),
                        'IBMPlexSans-SemiBold': require('@/assets/fonts/IBMPlexSans-SemiBold.ttf'),

                        // IBM Plex Mono family  
                        'IBMPlexMono-Regular': require('@/assets/fonts/IBMPlexMono-Regular.ttf'),
                        'IBMPlexMono-Italic': require('@/assets/fonts/IBMPlexMono-Italic.ttf'),
                        'IBMPlexMono-SemiBold': require('@/assets/fonts/IBMPlexMono-SemiBold.ttf'),

                        // Bricolage Grotesque  
                        'BricolageGrotesque-Bold': require('@/assets/fonts/BricolageGrotesque-Bold.ttf'),

                    });
                } catch (e) {
                    // Ignore
                }
            })();
        }
    });
}

function getDevEnvironmentCredentials(): AuthCredentials | null {
    if (!__DEV__) {
        return null;
    }

    const token = process.env.EXPO_PUBLIC_DEV_TOKEN;
    const secret = process.env.EXPO_PUBLIC_DEV_SECRET;
    if (!token || !secret) {
        return null;
    }

    return { token, secret };
}

function getDevWebQueryCredentials(): AuthCredentials | null {
    if (!__DEV__ || Platform.OS !== 'web' || typeof window === 'undefined') {
        return null;
    }

    const params = new URLSearchParams(window.location.search);
    const token = params.get('dev_token');
    const secret = params.get('dev_secret');
    if (!token || !secret) {
        return null;
    }

    return { token, secret };
}

export default function RootLayout() {
    useTauriZoom();
    useTauriDrag();
    const router = useRouter();
    const { theme } = useUnistyles();
    const navigationTheme = React.useMemo(() => {
        if (theme.dark) {
            return {
                ...DarkTheme,
                colors: {
                    ...DarkTheme.colors,
                    background: theme.colors.groupped.background,
                }
            }
        }
        return {
            ...DefaultTheme,
            colors: {
                ...DefaultTheme.colors,
                background: theme.colors.groupped.background,
            }
        };
    }, [theme.dark]);

    //
    // Init sequence
    //
    const [initState, setInitState] = React.useState<{ credentials: AuthCredentials | null } | null>(null);
    React.useEffect(() => {
        (async () => {
            try {
                // Before ANY relay traffic: fetches to the relay origin gain
                // the perimeter key header when one is configured.
                installRelayKeyFetchInterceptor();
                await loadFonts();
                await sodium.ready;

                let credentials = await TokenStorage.getCredentials();
                const queryCredentials = getDevWebQueryCredentials();
                const devCredentials = queryCredentials ?? getDevEnvironmentCredentials();

                if (devCredentials) {
                    const credentialsChanged = credentials?.token !== devCredentials.token
                        || credentials?.secret !== devCredentials.secret;

                    if (credentialsChanged) {
                        const saved = await TokenStorage.setCredentials(devCredentials);
                        if (saved) {
                            credentials = devCredentials;
                        }
                    }

                    // Scrub ONLY the consumed dev_token/dev_secret query params,
                    // and only when they came from the URL. Replacing the whole
                    // URL with the pathname also erased "#key=…" from
                    // /terminal/connect links before the approval screen read
                    // it, so terminal pairing failed under env auto-login (#185).
                    if (queryCredentials && Platform.OS === 'web' && typeof window !== 'undefined') {
                        window.history.replaceState({}, '', stripDevCredentialParams(window.location.href));
                    }
                }

                if (credentials) {
                    await syncRestore(credentials);
                }

                setInitState({ credentials });
            } catch (error) {
                console.error('Error initializing:', error);
                // A failed boot used to leave initState null forever: RootLayout
                // rendered nothing, the splash never hid, and the only way out
                // was clearing app data (#88). A stored secret that no longer
                // decodes, or a syncRestore that throws, must instead land on
                // the connect screen. Credentials that cannot decode are
                // dropped so the next boot does not trip over them again; an
                // environmental failure (no WebCrypto on an insecure origin,
                // a font that failed to load) keeps them for the next boot.
                try {
                    const stored = await TokenStorage.getCredentials();
                    if (stored && !areCredentialsUsable(stored)) {
                        await TokenStorage.removeCredentials();
                    }
                } catch (removeError) {
                    console.error('Error discarding unusable credentials:', removeError);
                }
                setInitState({ credentials: null });
            }
        })();
    }, []);

    React.useEffect(() => {
        if (initState) {
            setTimeout(() => {
                SplashScreen.hideAsync();
            }, 100);
        }
    }, [initState]);

    const handledNotificationIds = React.useRef<Set<string>>(new Set());
    const handleNotificationResponse = React.useCallback(async (response: Notifications.NotificationResponse | null) => {
        if (!response) {
            console.log('[PUSH ROUTING] Notification response is null');
            return;
        }

        console.log('[PUSH ROUTING] Full notification response:\n' + stringifyNotificationPayload(response));

        const responseId = response.notification.request.identifier;
        if (handledNotificationIds.current.has(responseId)) {
            console.log(`[PUSH ROUTING] Duplicate notification response ignored: ${responseId}`);
            return;
        }

        handledNotificationIds.current.add(responseId);

        try {
            if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) {
                console.log(`[PUSH ROUTING] Ignoring non-default action: ${response.actionIdentifier}`);
                return;
            }

            console.log(
                '[PUSH ROUTING] notification.request.content.data:\n' +
                stringifyNotificationPayload(response.notification.request.content.data)
            );
            const route = getSessionRouteFromNotificationResponse(response);
            console.log(`[PUSH ROUTING] Computed route: ${route ?? 'null'}`);
            if (!route) {
                console.log('[PUSH ROUTING] No session route found in notification.request.content.data');
                return;
            }

            const encodedSessionId = route.replace(/^\/session\//, '');
            const sessionId = (() => {
                try {
                    return decodeURIComponent(encodedSessionId);
                } catch {
                    return encodedSessionId;
                }
            })();
            console.log(`[PUSH ROUTING] Navigating to session: ${sessionId}`);
            // Cold start: the tap can arrive before the root navigator mounts,
            // and expo-router throws (or silently drops) navigation attempted
            // too early. Retry briefly instead of losing the tap.
            let attempts = 0;
            const tryNavigate = () => {
                try {
                    navigateToSession(router, sessionId);
                } catch (e) {
                    if (++attempts < 10) {
                        setTimeout(tryNavigate, 500);
                    } else {
                        console.log('[PUSH ROUTING] Giving up after retries:', e);
                    }
                }
            };
            tryNavigate();
        } finally {
            try {
                await Notifications.clearLastNotificationResponseAsync();
            } catch (error) {
                console.log('Failed to clear last notification response:', error);
            }
        }
    }, [router]);

    React.useEffect(() => {
        if (!initState) {
            return;
        }

        let active = true;
        const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
            void handleNotificationResponse(response);
        });

        void (async () => {
            try {
                const response = await Notifications.getLastNotificationResponseAsync();
                if (active) {
                    await handleNotificationResponse(response);
                }
            } catch (error) {
                console.log('Failed to read last notification response:', error);
            }
        })();

        return () => {
            active = false;
            subscription.remove();
        };
    }, [handleNotificationResponse, initState]);


    // Sync console output toggle from Dev screen
    const consoleLoggingEnabled = useLocalSetting('consoleLoggingEnabled');
    const devModeEnabled = __DEV__ || useLocalSetting('devModeEnabled');
    React.useEffect(() => {
        setConsoleOutputEnabled(consoleLoggingEnabled);
    }, [consoleLoggingEnabled]);

    //
    // Not inited
    //

    if (!initState) {
        return null;
    }

    //
    // Boot
    //

    let providers = (
        <SafeAreaProvider initialMetrics={initialWindowMetrics}>
            <KeyboardProvider preload={false}>
                <GestureHandlerRootView style={{ flex: 1 }}>
                    <AuthProvider initialCredentials={initState.credentials}>
                        <ThemeProvider value={navigationTheme}>
                            <StatusBarProvider />
                            <PathnameTracker />
                            <ModalProvider>
                                <BrowserNavigationShortcuts />
                                <CommandPaletteProvider>
                                    <RealtimeProvider>
                                        <HorizontalSafeAreaWrapper>
                                            <SidebarNavigator />
                                        </HorizontalSafeAreaWrapper>
                                    </RealtimeProvider>
                                </CommandPaletteProvider>
                            </ModalProvider>
                            <AppLockGate />
                        </ThemeProvider>
                    </AuthProvider>
                </GestureHandlerRootView>
            </KeyboardProvider>
        </SafeAreaProvider>
    );

    return (
        <>
            <FaviconPermissionIndicator />
            {providers}
        </>
    );
}
