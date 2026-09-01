import { View, Platform } from 'react-native';
import { openExternalUrl } from '@/utils/openExternalUrl';
import * as React from 'react';
import { Text } from '@/components/StyledText';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import * as Clipboard from 'expo-clipboard';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useConnectTerminal } from '@/hooks/useConnectTerminal';
import { useLocalSettingMutable } from '@/sync/storage';
import * as LocalAuthentication from 'expo-local-authentication';
import { Switch } from '@/components/Switch';
import { Modal } from '@/modal';
import { useHappyAction } from '@/hooks/useHappyAction';
import { useMultiClick } from '@/hooks/useMultiClick';
import { JoyLogoType } from '@/components/JoyLogotype';
import { useJoyMachines } from '@/hooks/useJoyMachines';
import { useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { useProfile } from '@/sync/storage';
import { getDisplayName, getAvatarUrl, getBio } from '@/sync/profile';
import { getServerUrl, relayNameForUrl } from '@/sync/serverConfig';
import { Avatar } from '@/components/Avatar';
import { t } from '@/text';

type BuildConfig = {
    buildCommitSha?: unknown;
    buildCommitTimestamp?: unknown;
    buildExportedAt?: unknown;
};

function getBuildConfig(): BuildConfig {
    const appConfig = Constants.expoConfig?.extra?.app;
    return appConfig && typeof appConfig === 'object' ? appConfig as BuildConfig : {};
}

function formatUtcTimestamp(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return value;
    }

    return date.toISOString()
        .replace(/\.\d{3}Z$/, 'Z')
        .replace(/:\d{2}Z$/, 'Z')
        .replace('T', ' ')
        .replace('Z', ' UTC');
}

function formatBuildSubtitle(buildConfig: BuildConfig): string | undefined {
    const commitTimestamp = typeof buildConfig.buildCommitTimestamp === 'string'
        ? formatUtcTimestamp(buildConfig.buildCommitTimestamp)
        : undefined;
    const commitSha = typeof buildConfig.buildCommitSha === 'string'
        ? buildConfig.buildCommitSha.slice(0, 7)
        : undefined;

    if (!commitTimestamp && !commitSha) {
        return undefined;
    }

    return [
        commitTimestamp ? `Commit ${commitTimestamp}` : 'Commit',
        commitSha,
    ].filter(Boolean).join(' / ');
}

// The JS bundle's identity — the ONLY reliable way to see whether an OTA
// landed: the native version string never changes on OTA, so "still says
// 1.2.0" tells you nothing. Embedded = the bundle shipped inside the binary;
// an id+timestamp = an OTA, stamped with when it was PUBLISHED.
function otaDetail(): string {
    try {
        // Web/desktop: expo-updates never runs (the desktop shell loads the
        // hosted bundle directly), so Updates.* would always say "embedded".
        // The export step stamps the bundle instead (EXPO_PUBLIC_BUILD_* are
        // inlined at build time) — show that, like an OTA id on mobile.
        if (Platform.OS === 'web') {
            // Env stamps win when the export script set them; otherwise fall
            // back to what app.config.js resolved at export time (commit sha
            // via git, export timestamp) so a bare `expo export` is never
            // unstamped.
            const cfg = getBuildConfig();
            const sha = process.env.EXPO_PUBLIC_BUILD_SHA
                ?? (typeof cfg.buildCommitSha === 'string' ? cfg.buildCommitSha.slice(0, 7) : undefined);
            const at = process.env.EXPO_PUBLIC_BUILD_TIME
                ?? (typeof cfg.buildExportedAt === 'string' ? cfg.buildExportedAt : undefined);
            const when = at
                ? new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                : '';
            if (sha) return `web ${sha}${when ? ` · ${when}` : ''}`;
            return 'web bundle (unstamped build)';
        }
        if (Updates.isEmbeddedLaunch || !Updates.updateId) return 'embedded bundle';
        const when = Updates.createdAt
            ? new Date(Updates.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
            : '';
        return `${Updates.updateId.slice(0, 8)}${when ? ` · ${when}` : ''}`;
    } catch {
        return 'unavailable';
    }
}

export const SettingsView = React.memo(function SettingsView() {
    const { theme } = useUnistyles();
    const router = useRouter();
    // Manual OTA pull: check → download → apply NOW (reloadAsync), replacing
    // the "force-quit twice and hope" dance — and unlike the silent automatic
    // check, every outcome is surfaced (up to date / restarting / real error).
    const [checkingUpdate, checkForUpdate] = useHappyAction(React.useCallback(async () => {
        const res = await Updates.checkForUpdateAsync();
        if (!res.isAvailable) {
            Modal.alert(t('settingsMods.jsUpdate'), t('settingsMods.upToDate'));
            return;
        }
        await Updates.fetchUpdateAsync();
        Modal.alert(t('settingsMods.jsUpdate'), t('settingsMods.updating'));
        await Updates.reloadAsync();
    }, []));
    const appVersion = Constants.expoConfig?.version || '1.0.0';
    const runtimeVersion = typeof Constants.expoConfig?.runtimeVersion === 'string'
        ? Constants.expoConfig.runtimeVersion
        : undefined;
    const versionDetail = [
        appVersion,
        runtimeVersion ? `runtime ${runtimeVersion}` : undefined,
    ].filter(Boolean).join(' / ');
    const versionSubtitle = formatBuildSubtitle(getBuildConfig());
    const [devModeEnabled, setDevModeEnabled] = useLocalSettingMutable('devModeEnabled');
    // App lock toggle: verify the device HAS security, then require a
    // successful auth to flip in EITHER direction (no silent disable).
    const [appLock, setAppLock] = useLocalSettingMutable('appLock');
    const toggleAppLock = React.useCallback(async (next: boolean) => {
        try {
            const level = await LocalAuthentication.getEnrolledLevelAsync();
            if (level === LocalAuthentication.SecurityLevel.NONE) {
                Modal.alert(t('appLock.noAuthTitle'), t('appLock.noAuth'));
                return;
            }
            const res = await LocalAuthentication.authenticateAsync({
                promptMessage: t('appLock.prompt'),
                disableDeviceFallback: false,
            });
            if (res.success) setAppLock(next);
        } catch {
            Modal.alert(t('appLock.noAuthTitle'), t('appLock.noAuth'));
        }
    }, [setAppLock]);
    const { machines: joyMachines } = useJoyMachines();
    const profile = useProfile();
    const displayName = getDisplayName(profile);
    const avatarUrl = getAvatarUrl(profile);
    const bio = getBio(profile);

    const { connectTerminal, connectWithUrl, isLoading } = useConnectTerminal();

    const handleGitHub = async () => {
        await openExternalUrl('https://github.com/fny/joy');
    };

    // Use the multi-click hook for version clicks
    const handleVersionClick = useMultiClick(() => {
        // Toggle dev mode
        const newDevMode = !devModeEnabled;
        setDevModeEnabled(newDevMode);
        Modal.alert(
            t('modals.developerMode'),
            newDevMode ? t('modals.developerModeEnabled') : t('modals.developerModeDisabled')
        );
    }, {
        requiredClicks: 10,
        resetTimeout: 2000
    });

    return (

        <ItemList style={{ paddingTop: 0 }}>
            {/* App Info Header */}
            <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                <View style={{ alignItems: 'center', paddingVertical: 24, backgroundColor: theme.colors.surface, marginTop: 16, borderRadius: 12, marginHorizontal: 16 }}>
                    {profile.firstName ? (
                        // Profile view: Avatar + name + version
                        <>
                            <View style={{ marginBottom: 12 }}>
                                <Avatar
                                    id={profile.id}
                                    size={90}
                                    imageUrl={avatarUrl}
                                    thumbhash={profile.avatar?.thumbhash}
                                />
                            </View>
                            <Text style={{ fontSize: 20, fontWeight: '600', color: theme.colors.text, marginBottom: bio ? 4 : 8 }}>
                                {displayName}
                            </Text>
                            {bio && (
                                <Text style={{ fontSize: 14, color: theme.colors.textSecondary, textAlign: 'center', marginBottom: 8, paddingHorizontal: 16 }}>
                                    {bio}
                                </Text>
                            )}
                        </>
                    ) : (
                        // Logo view: block-art wordmark + version
                        <>
                            <View style={{ marginBottom: 12 }}>
                                <JoyLogoType size={22} />
                            </View>
                        </>
                    )}
                </View>
            </View>

            {/* Connect Terminal - Only show on native platforms */}
            {Platform.OS !== 'web' && (
                <ItemGroup>
                    <Item
                        title={t('settings.scanQrCodeToAuthenticate')}
                        icon={<Ionicons name="qr-code-outline" size={29} color={theme.colors.accents.blue} />}
                        onPress={() => router.push('/settings/account')}
                        showChevron={false}
                    />
                </ItemGroup>
            )}

            {/* General */}
            <ItemGroup title="General">
                <Item
                    title={t('settings.account')}
                    subtitle={t('settings.accountSubtitle')}
                    icon={<Ionicons name="person-circle-outline" size={29} color={theme.colors.accents.blue} />}
                    onPress={() => router.push('/settings/account')}
                />
                <Item
                    title={t('settings.sessions')}
                    subtitle={t('settings.sessionsSubtitle')}
                    icon={<Ionicons name="albums-outline" size={29} color={theme.colors.accents.blue} />}
                    onPress={() => router.push('/settings/joy-sessions')}
                />
                <Item
                    title={t('settings.machines')}
                    subtitle={joyMachines.length > 0 ? `${joyMachines.length} connected` : 'None connected'}
                    icon={<Ionicons name="hardware-chip-outline" size={29} color={theme.colors.status.connected} />}
                    onPress={() => router.push('/settings/machines' as any)}
                />
                <Item
                    title="Relays"
                    subtitle={relayNameForUrl(getServerUrl())}
                    icon={<Ionicons name="git-network-outline" size={29} color={theme.colors.accents.indigo} />}
                    onPress={() => router.push('/server')}
                />
                <Item
                    title={t('settings.appearance')}
                    subtitle={t('settings.appearanceSubtitle')}
                    icon={<Ionicons name="color-palette-outline" size={29} color={theme.colors.accents.indigo} />}
                    onPress={() => router.push('/settings/appearance')}
                />
                <Item
                    title="Notifications"
                    subtitle="Desktop & mobile alerts"
                    icon={<Ionicons name="notifications-outline" size={29} color={theme.colors.accents.orange} />}
                    onPress={() => router.push('/settings/notifications' as any)}
                />
                <Item
                    title={t('settings.voiceAssistant')}
                    subtitle={t('settings.voiceAssistantSubtitle')}
                    icon={<Ionicons name="mic-outline" size={29} color={theme.colors.accents.green} />}
                    onPress={() => router.push('/settings/voice')}
                />
                <Item
                    title="Agent Defaults"
                    subtitle="Default model, effort, and permissions"
                    icon={<Ionicons name="options-outline" size={29} color={theme.colors.accents.blue} />}
                    onPress={() => router.push('/settings/agents' as any)}
                />
                <Item
                    title="Agent Config"
                    subtitle="Edit each agent's own config file on a machine"
                    icon={<Ionicons name="build-outline" size={29} color={theme.colors.accents.orange} />}
                    onPress={() => router.push('/settings/agent-config' as any)}
                />
                <Item
                    title={t('settings.featuresTitle')}
                    subtitle={t('settings.featuresSubtitle')}
                    icon={<Ionicons name="flask-outline" size={29} color={theme.colors.accents.orange} />}
                    onPress={() => router.push('/settings/features')}
                />
                <Item
                    title={t('settings.usage')}
                    subtitle={t('settings.usageSubtitle')}
                    icon={<Ionicons name="analytics-outline" size={29} color={theme.colors.accents.blue} />}
                    onPress={() => router.push('/settings/usage')}
                />
                <Item
                    title="Limits"
                    subtitle="Live account quota windows for Claude and Codex"
                    icon={<Ionicons name="hourglass-outline" size={29} color={theme.colors.accents.orange} />}
                    onPress={() => router.push('/settings/limits' as any)}
                />
                {Platform.OS !== 'web' && (
                    <Item
                        title={t('settings.appLock')}
                        subtitle={t('settings.appLockSubtitle')}
                        icon={<Ionicons name="lock-closed-outline" size={29} color={theme.colors.accents.green ?? '#34C759'} />}
                        rightElement={<Switch value={appLock} onValueChange={(v) => void toggleAppLock(v)} />}
                        showChevron={false}
                    />
                )}
            </ItemGroup>

            {/* Developer — always shown (joy build keeps dev tools in prod) */}
            <ItemGroup title={t('settings.developer')}>
                <Item
                    title={t('settings.joyHttp')}
                    subtitle={t('settings.joyHttpSubtitle')}
                    icon={<Ionicons name="globe-outline" size={29} color={theme.colors.textSecondary} />}
                    onPress={() => router.push('/settings/joy-http')}
                />
                <Item
                    title={t('settings.developerTools')}
                    icon={<Ionicons name="construct-outline" size={29} color={theme.colors.accents.indigo} />}
                    onPress={() => router.push('/dev')}
                />
                {/* Raw settings JSON editor (relocated from the mods page). Joy
                    dev tool — plain string, matching the raw editor page itself. */}
                <Item
                    title="Raw settings"
                    subtitle="View and edit the raw settings JSON"
                    icon={<Ionicons name="code-slash-outline" size={29} color={theme.colors.textSecondary} />}
                    onPress={() => router.push('/settings/raw')}
                />
            </ItemGroup>

            {/* About */}
            <ItemGroup title={t('settings.about')} footer={t('settings.aboutFooter')}>
                <Item
                    title={t('settings.whatsNew')}
                    subtitle={t('settings.whatsNewSubtitle')}
                    icon={<Ionicons name="sparkles-outline" size={29} color={theme.colors.accents.orange} />}
                    onPress={() => {
                        router.push('/changelog');
                    }}
                />
                <Item
                    title={t('settings.github')}
                    icon={<Ionicons name="logo-github" size={29} color={theme.colors.text} />}
                    detail="fny/joy"
                    onPress={handleGitHub}
                />
                <Item
                    title={t('settingsMods.jsUpdate')}
                    subtitle={t('settingsMods.jsUpdateDescription')}
                    detail={otaDetail()}
                    icon={<Ionicons name="cloud-download-outline" size={29} color={theme.colors.textSecondary} />}
                    showChevron={false}
                    onPress={() => {
                        // Copy the FULL update id (detail shows a truncated one) —
                        // it's the thing you paste when reporting which bundle
                        // you're on.
                        const full = Updates.updateId ?? otaDetail();
                        void Clipboard.setStringAsync(full);
                        Modal.alert(t('common.copied'), full);
                    }}
                />
                <Item
                    title={t('settingsMods.checkForUpdate')}
                    icon={<Ionicons name="refresh-outline" size={29} color={theme.colors.textSecondary} />}
                    loading={checkingUpdate}
                    onPress={checkingUpdate ? undefined : checkForUpdate}
                />
                <Item
                    title={t('common.version')}
                    subtitle={versionSubtitle}
                    subtitleLines={2}
                    detail={versionDetail}
                    icon={<Ionicons name="information-circle-outline" size={29} color={theme.colors.textSecondary} />}
                    onPress={handleVersionClick}
                    showChevron={false}
                />
            </ItemGroup>

        </ItemList>
    );
});
