import { View, Platform } from 'react-native';
import { openExternalUrl } from '@/utils/openExternalUrl';
import * as React from 'react';
import { Text } from '@/components/StyledText';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useConnectTerminal } from '@/hooks/useConnectTerminal';
import { useLocalSettingMutable } from '@/sync/storage';
import { trackWhatsNewClicked } from '@/track';
import { Modal } from '@/modal';
import { useMultiClick } from '@/hooks/useMultiClick';
import { JoyLogoType } from '@/components/JoyLogotype';
import { useJoyMachines } from '@/hooks/useJoyMachines';
import { useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { useProfile } from '@/sync/storage';
import { getDisplayName, getAvatarUrl, getBio } from '@/sync/profile';
import { Avatar } from '@/components/Avatar';
import { t } from '@/text';

type BuildConfig = {
    buildCommitSha?: unknown;
    buildCommitTimestamp?: unknown;
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

export const SettingsView = React.memo(function SettingsView() {
    const { theme } = useUnistyles();
    const router = useRouter();
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
                        onPress={connectTerminal}
                        loading={isLoading}
                        showChevron={false}
                    />
                    <Item
                        title={t('connect.enterUrlManually')}
                        icon={<Ionicons name="link-outline" size={29} color={theme.colors.accents.blue} />}
                        onPress={async () => {
                            const url = await Modal.prompt(
                                t('modals.authenticateTerminal'),
                                t('modals.pasteUrlFromTerminal'),
                                {
                                    placeholder: 'happy://terminal?...',
                                    confirmText: t('common.authenticate')
                                }
                            );
                            if (url?.trim()) {
                                connectWithUrl(url.trim());
                            }
                        }}
                        showChevron={false}
                    />
                </ItemGroup>
            )}

            {/* Social */}
            {/* <ItemGroup title={t('settings.social')}>
                <Item
                    title={t('navigation.friends')}
                    subtitle={t('friends.manageFriends')}
                    icon={<Ionicons name="people-outline" size={29} color={theme.colors.accents.blue} />}
                    onPress={() => router.push('/friends')}
                />
            </ItemGroup> */}

            {/* Machines — only boxes running the joy-tmux daemon */}
            {joyMachines.length > 0 && (
                <ItemGroup title={t('settings.machines')}>
                    {joyMachines.map((machine) => {
                        const host = machine.metadata?.host || 'Unknown';
                        const displayName = machine.metadata?.displayName;
                        const platform = machine.metadata?.platform || '';
                        const title = displayName || host;
                        let subtitle = displayName && displayName !== host ? host : '';
                        if (platform) subtitle = subtitle ? `${subtitle} • ${platform}` : platform;
                        subtitle = subtitle ? `${subtitle} • joy-tmux` : 'joy-tmux';

                        return (
                            <Item
                                key={machine.id}
                                title={title}
                                subtitle={subtitle}
                                icon={<Ionicons name="terminal-outline" size={29} color={theme.colors.status.connected} />}
                                onPress={() => router.push(`/machine/${machine.id}`)}
                            />
                        );
                    })}
                </ItemGroup>
            )}

            {/* Features */}
            <ItemGroup title={t('settings.features')}>
                <Item
                    title={t('settings.account')}
                    subtitle={t('settings.accountSubtitle')}
                    icon={<Ionicons name="person-circle-outline" size={29} color={theme.colors.accents.blue} />}
                    onPress={() => router.push('/settings/account')}
                />
                <Item
                    title={t('settings.sessions')}
                    subtitle={t('settings.sessionsSubtitle')}
                    icon={<Ionicons name="terminal-outline" size={29} color={theme.colors.accents.blue} />}
                    onPress={() => router.push('/settings/joy-sessions')}
                />
                <Item
                    title={t('settings.mods')}
                    subtitle={t('settings.modsSubtitle')}
                    icon={<Ionicons name="construct-outline" size={29} color={theme.colors.accents.orange} />}
                    onPress={() => router.push('/settings/mods')}
                />
                <Item
                    title={t('settings.appearance')}
                    subtitle={t('settings.appearanceSubtitle')}
                    icon={<Ionicons name="color-palette-outline" size={29} color={theme.colors.accents.indigo} />}
                    onPress={() => router.push('/settings/appearance')}
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
            </ItemGroup>

            {/* About */}
            <ItemGroup title={t('settings.about')} footer={t('settings.aboutFooter')}>
                <Item
                    title={t('settings.whatsNew')}
                    subtitle={t('settings.whatsNewSubtitle')}
                    icon={<Ionicons name="sparkles-outline" size={29} color={theme.colors.accents.orange} />}
                    onPress={() => {
                        trackWhatsNewClicked();
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
                    title={t('settings.privacyPolicy')}
                    icon={<Ionicons name="shield-checkmark-outline" size={29} color={theme.colors.accents.blue} />}
                    onPress={() => openExternalUrl('https://happy.engineering/privacy/')}
                />
                <Item
                    title={t('settings.termsOfService')}
                    icon={<Ionicons name="document-text-outline" size={29} color={theme.colors.accents.blue} />}
                    onPress={() => openExternalUrl('https://github.com/slopus/happy/blob/main/TERMS.md')}
                />
                {Platform.OS === 'ios' && (
                    <Item
                        title={t('settings.eula')}
                        icon={<Ionicons name="document-text-outline" size={29} color={theme.colors.accents.blue} />}
                        onPress={() => openExternalUrl('https://www.apple.com/legal/internet-services/itunes/dev/stdeula/')}
                    />
                )}
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
