import { useAuth } from '@/auth/AuthContext';
import * as React from 'react';
import { Drawer } from 'expo-router/drawer';
import { useIsTablet, useHeaderHeight } from '@/utils/responsive';
import { SidebarView } from './SidebarView';
import { useWindowDimensions, View, Pressable, Platform } from 'react-native';
import { useLocalSetting, useLocalSettingMutable } from '@/sync/storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, usePathname } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import Octicons from '@expo/vector-icons/Octicons';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { isTauri } from '@/utils/isTauri';
import { useOverlayNav } from '@/-session/sessionOverlayNav';
import { DEFAULT_APP_ZOOM } from '@/hooks/useTauriZoom';
import { applyNavPathname, canNavBack, canNavForward, createNavHistory, type NavDirection } from './sidebarNavHistory';

const TAURI_HEADER_CONTROL_LEFT = Math.ceil(92 / DEFAULT_APP_ZOOM);

/**
 * Tracks navigation history to determine if back/forward is possible.
 * We maintain our own stack + cursor because the web History API
 * doesn't expose whether forward entries exist. The model lives in
 * sidebarNavHistory.ts; this hook feeds it the pathname changes plus how
 * they happened: our own buttons mark 'back'/'forward', a browser
 * back/forward/gesture is observed via `popstate` and marked 'pop' so it
 * moves the cursor instead of appending a new entry (#240).
 */
function useNavHistory() {
    const pathname = usePathname();
    const historyRef = React.useRef(createNavHistory(pathname));
    const directionRef = React.useRef<NavDirection>(null);
    const [canGoBack, setCanGoBack] = React.useState(false);
    const [canGoForward, setCanGoForward] = React.useState(false);

    React.useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') return;
        const onPopState = () => {
            // Only when nothing else already claimed this transition.
            if (directionRef.current === null) directionRef.current = 'pop';
        };
        window.addEventListener('popstate', onPopState);
        return () => window.removeEventListener('popstate', onPopState);
    }, []);

    React.useEffect(() => {
        const dir = directionRef.current;
        directionRef.current = null;
        historyRef.current = applyNavPathname(historyRef.current, pathname, dir);
        setCanGoBack(canNavBack(historyRef.current));
        setCanGoForward(canNavForward(historyRef.current));
    }, [pathname]);

    const markBack = React.useCallback(() => { directionRef.current = 'back'; }, []);
    const markForward = React.useCallback(() => { directionRef.current = 'forward'; }, []);

    return { canGoBack, canGoForward, markBack, markForward };
}

export const SidebarNavigator = React.memo(() => {
    const auth = useAuth();
    const isTablet = useIsTablet();
    const zenMode = useLocalSetting('zenMode');
    const isDesktopLayout = auth.isAuthenticated && isTablet;
    const showSidebar = isDesktopLayout && !zenMode;
    const { width: windowWidth } = useWindowDimensions();

    // Calculate target drawer width
    const fullDrawerWidth = React.useMemo(() => {
        if (!isDesktopLayout) return 280;
        return Math.min(Math.max(Math.floor(windowWidth * 0.3), 250), 360);
    }, [windowWidth, isDesktopLayout]);
    const drawerWidth = showSidebar ? fullDrawerWidth : 0;

    const drawerNavigationOptions = React.useMemo(() => {
        if (!isDesktopLayout) {
            // Non-tablet: use front drawer, hidden
            return {
                lazy: false,
                headerShown: false,
                drawerType: 'front' as const,
                swipeEnabled: false,
                drawerStyle: {
                    width: 0,
                    display: 'none' as const,
                },
            };
        }

        // Tablet: always permanent, just collapse width in zen mode.
        //
        // We deliberately do NOT animate `width` on web. A CSS transition on
        // the drawer width re-flowed the chat flex-1 sibling on every frame,
        // re-measuring the entire FlatList tree at ~15fps. Snapping the
        // width change makes the chat reflow exactly once. Native already
        // snaps because RN doesn't honor CSS transition properties.
        return {
            lazy: false,
            headerShown: false,
            drawerType: 'permanent' as const,
            drawerStyle: {
                backgroundColor: 'white',
                borderRightWidth: 0,
                width: drawerWidth,
                overflow: 'hidden' as const,
            } as any,
            swipeEnabled: false,
            drawerActiveTintColor: 'transparent',
            drawerInactiveTintColor: 'transparent',
            drawerItemStyle: { display: 'none' as const },
            drawerLabelStyle: { display: 'none' as const },
        };
    }, [isDesktopLayout, drawerWidth]);

    const drawerContent = React.useCallback(
        () => <SidebarView />,
        []
    );

    return (
        <View style={{ flex: 1 }}>
            <Drawer
                screenOptions={drawerNavigationOptions}
                drawerContent={isDesktopLayout ? drawerContent : undefined}
            />
            {/* Persistent header overlay — always visible on desktop, same position regardless of zen mode */}
            {isDesktopLayout && (
                <PersistentHeader />
            )}
        </View>
    );
});

// Header block that stays in the same position whether zen mode is on or off
const PersistentHeader = React.memo(() => {
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const router = useRouter();
    const [zenMode, setZenMode] = useLocalSettingMutable('zenMode');
    const inTauri = isTauri();
    const isMacTauri = inTauri && typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

    const { canGoBack, canGoForward, markBack, markForward } = useNavHistory();
    const overlayCanBack = useOverlayNav((s) => s.canBack);
    const overlayCanForward = useOverlayNav((s) => s.canForward);

    const handleZenToggle = React.useCallback(() => {
        setZenMode(!zenMode);
    }, [zenMode, setZenMode]);

    const handleBack = React.useCallback(() => {
        // Intra-session overlay (file diff / file view) consumes back first,
        // so the chat → diff → file flow can be unwound without a close X.
        if (useOverlayNav.getState().back()) return;
        markBack();
        router.back();
    }, [router, markBack]);

    const handleForward = React.useCallback(() => {
        if (useOverlayNav.getState().forward()) return;
        if (Platform.OS === 'web' && typeof window !== 'undefined') {
            markForward();
            window.history.forward();
        }
    }, [markForward]);

    const canGoBackEffective = canGoBack || overlayCanBack;
    const canGoForwardEffective = canGoForward || overlayCanForward;

    return (
        <View
            style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                paddingTop: safeArea.top,
                paddingLeft: isMacTauri ? TAURI_HEADER_CONTROL_LEFT : 16,
                paddingRight: 16,
                height: safeArea.top + headerHeight,
                flexDirection: 'row',
                alignItems: 'center',
                zIndex: 1100,
            }}
            pointerEvents="box-none"
            {...(inTauri ? { dataSet: { tauriDragRegion: 'true' } } : {})}
        >
            {/* Zen / Back / Forward buttons */}
            <View
                style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
                pointerEvents="auto"
                {...(inTauri ? { dataSet: { tauriDragRegion: 'false' } } : {})}
            >
                <Pressable
                    onPress={handleZenToggle}
                    hitSlop={10}
                    style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center', opacity: zenMode ? 0.3 : 1 }}
                    accessibilityLabel={t('zen.toggle')}
                >
                    {/* Collapse when the sidebar is open, expand when it's collapsed (zen).
                        Dim when collapsed (like the disabled forward button), never blue. */}
                    <Octicons
                        name={zenMode ? 'sidebar-expand' : 'sidebar-collapse'}
                        size={18}
                        color={theme.colors.header.tint}
                    />
                </Pressable>
                <Pressable onPress={handleBack} disabled={!canGoBackEffective} hitSlop={10} style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center', opacity: canGoBackEffective ? 1 : 0.3 }}>
                    <Ionicons name="chevron-back" size={20} color={theme.colors.header.tint} />
                </Pressable>
                {Platform.OS === 'web' && (
                    <Pressable onPress={handleForward} disabled={!canGoForwardEffective} hitSlop={10} style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center', opacity: canGoForwardEffective ? 1 : 0.3 }}>
                        <Ionicons name="chevron-forward" size={20} color={theme.colors.header.tint} />
                    </Pressable>
                )}
            </View>
        </View>
    );
});
