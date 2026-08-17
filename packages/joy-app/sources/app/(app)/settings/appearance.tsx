import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable, useLocalSettingMutable, storage } from '@/sync/storage';
import { applyAppearance, applyDarkAppearance } from '@/palettes';
import { useRouter } from 'expo-router';
import * as Localization from 'expo-localization';
import { useUnistyles, UnistylesRuntime, StyleSheet } from 'react-native-unistyles';
import { Switch } from '@/components/Switch';
import { AvatarHashicon, AvatarSquares, AvatarCircles } from '@/components/AvatarHashicon';
import { Appearance, Platform, Pressable, Text, View } from 'react-native';
import * as SystemUI from 'expo-system-ui';
import { darkTheme, lightTheme } from '@/theme';
import { t, getLanguageNativeName, SUPPORTED_LANGUAGES } from '@/text';
import { TerminalControls } from '@/components/dev/TerminalControls';
import { Typography } from '@/constants/Typography';
import { clampChatFontScale, CHAT_FONT_SCALE_MIN, CHAT_FONT_SCALE_MAX, CHAT_FONT_SCALE_STEP } from '@/hooks/useChatFontScale';

// Define known avatar styles for this version of the app
type KnownAvatarStyle = 'pixelated' | 'gradient' | 'brutalist';

const isKnownAvatarStyle = (style: string): style is KnownAvatarStyle => {
    return style === 'pixelated' || style === 'gradient' || style === 'brutalist';
};

// Live preview of chat text at the current scale, mirroring the real chat
// metrics (16/24 × scale, per MessageView/MarkdownView): a user bubble on the
// right and a plain agent line on the left. Rendered as a component (not a
// bare View) so the showDivider prop ItemGroup clones onto children is
// silently swallowed.
function ChatFontSizePreview({ scale }: { scale: number; showDivider?: boolean }) {
    const scaledText = { fontSize: 16 * scale, lineHeight: 24 * scale };
    return (
        <View style={styles.previewContainer}>
            <View style={styles.previewBubble}>
                <Text style={[styles.previewUserText, scaledText]} selectable={false}>
                    {t('settingsAppearance.chatFontSizePreviewUser')}
                </Text>
            </View>
            <Text style={[styles.previewAgentText, scaledText]} selectable={false}>
                {t('settingsAppearance.chatFontSizePreviewAgent')}
            </Text>
        </View>
    );
}

export default function AppearanceSettingsScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const [viewInline, setViewInline] = useSettingMutable('viewInline');
    const [expandTodos, setExpandTodos] = useSettingMutable('expandTodos');
    const [showLineNumbers, setShowLineNumbers] = useSettingMutable('showLineNumbers');
    const [showLineNumbersInToolViews, setShowLineNumbersInToolViews] = useSettingMutable('showLineNumbersInToolViews');
    const [wrapLinesInDiffs, setWrapLinesInDiffs] = useSettingMutable('wrapLinesInDiffs');
    const [diffStyle, setDiffStyle] = useSettingMutable('diffStyle');
    const [alwaysShowContextSize, setAlwaysShowContextSize] = useSettingMutable('alwaysShowContextSize');
    const [avatarStyle, setAvatarStyle] = useSettingMutable('avatarStyle');
    const [showFlavorIcons, setShowFlavorIcons] = useSettingMutable('showFlavorIcons');
    const [themePreference, setThemePreference] = useLocalSettingMutable('themePreference');
    const [avatarVariant, setAvatarVariant] = useLocalSettingMutable('avatarVariant');
    const [sessionAvatarSize, setSessionAvatarSize] = useLocalSettingMutable('sessionAvatarSize');
    const [preferredLanguage] = useSettingMutable('preferredLanguage');
    const [chatFontScaleRaw, setChatFontScale] = useLocalSettingMutable('chatFontScale');
    const chatFontScale = clampChatFontScale(chatFontScaleRaw);
    const bumpChatFontScale = (dir: 1 | -1) => setChatFontScale(clampChatFontScale(chatFontScale + dir * CHAT_FONT_SCALE_STEP));
    
    // Ensure we have a valid style for display, defaulting to gradient for unknown values
    const displayStyle: KnownAvatarStyle = isKnownAvatarStyle(avatarStyle) ? avatarStyle : 'gradient';
    
    // Language display
    const getLanguageDisplayText = () => {
        if (preferredLanguage === null) {
            const deviceLocale = Localization.getLocales()?.[0]?.languageTag ?? 'en-US';
            const deviceLanguage = deviceLocale.split('-')[0].toLowerCase();
            const detectedLanguageName = deviceLanguage in SUPPORTED_LANGUAGES ? 
                                        getLanguageNativeName(deviceLanguage as keyof typeof SUPPORTED_LANGUAGES) : 
                                        getLanguageNativeName('en');
            return `${t('settingsLanguage.automatic')} (${detectedLanguageName})`;
        } else if (preferredLanguage && preferredLanguage in SUPPORTED_LANGUAGES) {
            return getLanguageNativeName(preferredLanguage as keyof typeof SUPPORTED_LANGUAGES);
        }
        return t('settingsLanguage.automatic');
    };
    return (
        <ItemList style={{ paddingTop: 0 }}>

            {/* Identicon style — three variants, all drawn from the joy
                logotype palette (+darken/lighten): the hashicon mark, a square
                confetti grid, and a circular confetti grid. Live previews. */}
            <ItemGroup title="Identicons" footer="Style for generated avatars (sessions, machines). Colors come from the joy logo palette.">
                {([
                    { key: 'hashicon' as const, name: 'Hashicon', Comp: AvatarHashicon },
                    { key: 'squares' as const, name: 'Squares', Comp: AvatarSquares },
                    { key: 'circles' as const, name: 'Circles', Comp: AvatarCircles },
                ]).map(({ key, name, Comp }) => (
                    <Item
                        key={key}
                        title={name}
                        icon={<Comp id="preview-joy" size={29} />}
                        rightElement={(
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                <Comp id="sample-a" size={24} />
                                <Comp id="sample-b" size={24} />
                                <Comp id="sample-c" size={24} />
                                {avatarVariant === key && (
                                    <Ionicons name="checkmark" size={18} color={theme.colors.textLink} style={{ marginLeft: 4 }} />
                                )}
                            </View>
                        )}
                        showChevron={false}
                        onPress={() => setAvatarVariant(key)}
                    />
                ))}
                <Item
                    title="Size"
                    subtitle="Session-list identicon size"
                    icon={<View style={{ width: 29, alignItems: 'center' }}>
                        {avatarVariant === 'squares' ? <AvatarSquares id="preview-joy" size={Math.min(29, sessionAvatarSize)} />
                            : avatarVariant === 'circles' ? <AvatarCircles id="preview-joy" size={Math.min(29, sessionAvatarSize)} />
                                : <AvatarHashicon id="preview-joy" size={Math.min(29, sessionAvatarSize)} />}
                    </View>}
                    rightElement={(
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                            <Pressable
                                hitSlop={8}
                                onPress={() => setSessionAvatarSize(Math.max(16, sessionAvatarSize - 4))}
                                disabled={sessionAvatarSize <= 16}
                            >
                                <Ionicons name="remove-circle-outline" size={22} color={sessionAvatarSize <= 16 ? theme.colors.textSecondary : theme.colors.textLink} />
                            </Pressable>
                            <Text style={{ color: theme.colors.text, fontVariant: ['tabular-nums'], minWidth: 30, textAlign: 'center' }}>{sessionAvatarSize}px</Text>
                            <Pressable
                                hitSlop={8}
                                onPress={() => setSessionAvatarSize(Math.min(48, sessionAvatarSize + 4))}
                                disabled={sessionAvatarSize >= 48}
                            >
                                <Ionicons name="add-circle-outline" size={22} color={sessionAvatarSize >= 48 ? theme.colors.textSecondary : theme.colors.textLink} />
                            </Pressable>
                        </View>
                    )}
                    showChevron={false}
                />
            </ItemGroup>

            {/* Theme Settings */}
            <ItemGroup title={t('settingsAppearance.theme')} footer={t('settingsAppearance.themeDescription')}>
                <Item
                    title={t('settings.appearance')}
                    subtitle={themePreference === 'adaptive' ? t('settingsAppearance.themeDescriptions.adaptive') : themePreference === 'light' ? t('settingsAppearance.themeDescriptions.light') : t('settingsAppearance.themeDescriptions.dark')}
                    icon={<Ionicons name="contrast-outline" size={29} color={theme.colors.status.connecting} />}
                    detail={themePreference === 'adaptive' ? t('settingsAppearance.themeOptions.adaptive') : themePreference === 'light' ? t('settingsAppearance.themeOptions.light') : t('settingsAppearance.themeOptions.dark')}
                    onPress={() => {
                        const currentIndex = themePreference === 'adaptive' ? 0 : themePreference === 'light' ? 1 : 2;
                        const nextIndex = (currentIndex + 1) % 3;
                        const nextTheme = nextIndex === 0 ? 'adaptive' : nextIndex === 1 ? 'light' : 'dark';
                        
                        // Update the setting
                        setThemePreference(nextTheme);
                        
                        // Apply the theme change immediately
                        if (nextTheme === 'adaptive') {
                            // Enable adaptive themes and set to system theme
                            UnistylesRuntime.setAdaptiveThemes(true);
                            const systemTheme = Appearance.getColorScheme();
                            const color = systemTheme === 'dark' ? darkTheme.colors.groupped.background : lightTheme.colors.groupped.background;
                            UnistylesRuntime.setRootViewBackgroundColor(color);
                            SystemUI.setBackgroundColorAsync(color);
                        } else {
                            // Disable adaptive themes and set explicit theme
                            UnistylesRuntime.setAdaptiveThemes(false);
                            UnistylesRuntime.setTheme(nextTheme);
                            const color = nextTheme === 'dark' ? darkTheme.colors.groupped.background : lightTheme.colors.groupped.background;
                            UnistylesRuntime.setRootViewBackgroundColor(color);
                            SystemUI.setBackgroundColorAsync(color);
                        }

                        // Re-apply the resolved theme's palette so it follows the
                        // appearance mode (and overrides the stock background above).
                        const ls = storage.getState().localSettings;
                        const resolved = nextTheme === 'adaptive'
                            ? (Appearance.getColorScheme() === 'dark' ? 'dark' : 'light')
                            : nextTheme;
                        if (resolved === 'dark') {
                            applyDarkAppearance(ls.themePaletteDark);
                        } else {
                            applyAppearance(ls.themePalette, ls.customPalette, ls.accentOverrides);
                        }
                    }}
                />
            </ItemGroup>

            {/* Language Settings */}
            <ItemGroup title={t('settingsLanguage.title')} footer={t('settingsLanguage.description')}>
                <Item
                    title={t('settingsLanguage.currentLanguage')}
                    icon={<Ionicons name="language-outline" size={29} color={theme.colors.accents.blue} />}
                    detail={getLanguageDisplayText()}
                    onPress={() => router.push('/settings/language')}
                />
            </ItemGroup>

            {/* Chat text size */}
            <ItemGroup title={t('settingsAppearance.chatFontSize')} footer={t('settingsAppearance.chatFontSizeDescription')}>
                <Item
                    title={t('settingsAppearance.chatFontSize')}
                    icon={<Ionicons name="text-outline" size={29} color={theme.colors.accents.orange} />}
                    rightElement={
                        <View style={styles.fontScaleControls}>
                            {chatFontScale !== 1 && (
                                <Pressable
                                    onPress={() => setChatFontScale(1)}
                                    hitSlop={8}
                                    accessibilityRole="button"
                                    style={({ pressed }) => [styles.fontScaleReset, pressed && styles.fontScalePressed]}
                                >
                                    <Text style={styles.fontScaleResetText}>{t('common.reset')}</Text>
                                </Pressable>
                            )}
                            <Pressable
                                onPress={() => bumpChatFontScale(-1)}
                                disabled={chatFontScale <= CHAT_FONT_SCALE_MIN}
                                hitSlop={8}
                                accessibilityRole="button"
                                accessibilityLabel={t('settingsAppearance.chatFontSizeDecrease')}
                                style={({ pressed }) => [
                                    styles.fontScaleButton,
                                    pressed && styles.fontScalePressed,
                                    chatFontScale <= CHAT_FONT_SCALE_MIN && styles.fontScaleDisabled,
                                ]}
                            >
                                <Ionicons name="remove" size={18} color={theme.colors.text} />
                            </Pressable>
                            <Text style={styles.fontScaleValue}>{`${Math.round(chatFontScale * 100)}%`}</Text>
                            <Pressable
                                onPress={() => bumpChatFontScale(1)}
                                disabled={chatFontScale >= CHAT_FONT_SCALE_MAX}
                                hitSlop={8}
                                accessibilityRole="button"
                                accessibilityLabel={t('settingsAppearance.chatFontSizeIncrease')}
                                style={({ pressed }) => [
                                    styles.fontScaleButton,
                                    pressed && styles.fontScalePressed,
                                    chatFontScale >= CHAT_FONT_SCALE_MAX && styles.fontScaleDisabled,
                                ]}
                            >
                                <Ionicons name="add" size={18} color={theme.colors.text} />
                            </Pressable>
                        </View>
                    }
                />
                <ChatFontSizePreview scale={chatFontScale} />
            </ItemGroup>

            {/* Text Settings */}
            {/* <ItemGroup title="Text" footer="Adjust text size and font preferences">
                <Item
                    title="Text Size"
                    subtitle="Make text larger or smaller"
                    icon={<Ionicons name="text-outline" size={29} color={theme.colors.accents.orange} />}
                    detail="Default"
                    onPress={() => { }}
                    disabled
                />
                <Item
                    title="Font"
                    subtitle="Choose your preferred font"
                    icon={<Ionicons name="text-outline" size={29} color={theme.colors.accents.orange} />}
                    detail="System"
                    onPress={() => { }}
                    disabled
                />
            </ItemGroup> */}

            {/* Display Settings */}
            <ItemGroup title={t('settingsAppearance.display')} footer={t('settingsAppearance.displayDescription')}>
                <Item
                    title={t('settingsAppearance.inlineToolCalls')}
                    subtitle={t('settingsAppearance.inlineToolCallsDescription')}
                    icon={<Ionicons name="code-slash-outline" size={29} color={theme.colors.accents.indigo} />}
                    rightElement={
                        <Switch
                            value={viewInline}
                            onValueChange={setViewInline}
                        />
                    }
                />
                <Item
                    title={t('settingsAppearance.expandTodoLists')}
                    subtitle={t('settingsAppearance.expandTodoListsDescription')}
                    icon={<Ionicons name="checkmark-done-outline" size={29} color={theme.colors.accents.indigo} />}
                    rightElement={
                        <Switch
                            value={expandTodos}
                            onValueChange={setExpandTodos}
                        />
                    }
                />
                <Item
                    title={t('settingsAppearance.showLineNumbersInDiffs')}
                    subtitle={t('settingsAppearance.showLineNumbersInDiffsDescription')}
                    icon={<Ionicons name="list-outline" size={29} color={theme.colors.accents.indigo} />}
                    rightElement={
                        <Switch
                            value={showLineNumbers}
                            onValueChange={setShowLineNumbers}
                        />
                    }
                />
                <Item
                    title={t('settingsAppearance.showLineNumbersInToolViews')}
                    subtitle={t('settingsAppearance.showLineNumbersInToolViewsDescription')}
                    icon={<Ionicons name="code-working-outline" size={29} color={theme.colors.accents.indigo} />}
                    rightElement={
                        <Switch
                            value={showLineNumbersInToolViews}
                            onValueChange={setShowLineNumbersInToolViews}
                        />
                    }
                />
                <Item
                    title={t('settingsAppearance.wrapLinesInDiffs')}
                    subtitle={t('settingsAppearance.wrapLinesInDiffsDescription')}
                    icon={<Ionicons name="return-down-forward-outline" size={29} color={theme.colors.accents.indigo} />}
                    rightElement={
                        <Switch
                            value={wrapLinesInDiffs}
                            onValueChange={setWrapLinesInDiffs}
                        />
                    }
                />
                {/* Split rendering exists only in the web diff renderer —
                    native always draws unified (side-by-side doesn't fit phone
                    widths), so offering the toggle there was a dead switch. */}
                {Platform.OS === 'web' && (
                    <Item
                        title={t('settingsAppearance.diffStyle')}
                        subtitle={t('settingsAppearance.diffStyleDescription')}
                        icon={<Ionicons name="git-compare-outline" size={29} color={theme.colors.accents.indigo} />}
                        detail={diffStyle === 'split' ? t('settingsAppearance.diffStyleOptions.split') : t('settingsAppearance.diffStyleOptions.unified')}
                        onPress={() => setDiffStyle(diffStyle === 'unified' ? 'split' : 'unified')}
                    />
                )}
                <Item
                    title={t('settingsAppearance.alwaysShowContextSize')}
                    subtitle={t('settingsAppearance.alwaysShowContextSizeDescription')}
                    icon={<Ionicons name="analytics-outline" size={29} color={theme.colors.accents.indigo} />}
                    rightElement={
                        <Switch
                            value={alwaysShowContextSize}
                            onValueChange={setAlwaysShowContextSize}
                        />
                    }
                />
                <Item
                    title={t('settingsAppearance.showFlavorIcons')}
                    subtitle={t('settingsAppearance.showFlavorIconsDescription')}
                    icon={<Ionicons name="apps-outline" size={29} color={theme.colors.accents.indigo} />}
                    rightElement={
                        <Switch
                            value={showFlavorIcons}
                            onValueChange={setShowFlavorIcons}
                        />
                    }
                />
                {/* <Item
                    title="Compact Mode"
                    subtitle="Reduce spacing between elements"
                    icon={<Ionicons name="contract-outline" size={29} color={theme.colors.accents.indigo} />}
                    disabled
                    rightElement={
                        <Switch
                            value={false}
                            disabled
                        />
                    }
                />
                <Item
                    title="Show Avatars"
                    subtitle="Display user and assistant avatars"
                    icon={<Ionicons name="person-circle-outline" size={29} color={theme.colors.accents.indigo} />}
                    disabled
                    rightElement={
                        <Switch
                            value={true}
                            disabled
                        />
                    }
                /> */}
            </ItemGroup>

            {/* Colors */}
            <ItemGroup title="Colors" footer="Try alternate color palettes, or enter your own.">
                <Item
                    title="Color Palette"
                    subtitle="Background, surfaces, text and accent"
                    icon={<Ionicons name="color-palette-outline" size={29} color={theme.colors.accents.red} />}
                    onPress={() => router.push('/settings/palette')}
                />
            </ItemGroup>

            {/* Terminal theme picker */}
            <TerminalControls />
        </ItemList>
    );
}

const styles = StyleSheet.create((theme) => ({
    fontScaleControls: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    fontScaleButton: {
        width: 32,
        height: 32,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surfaceHighest,
    },
    fontScalePressed: {
        opacity: 0.6,
    },
    fontScaleDisabled: {
        opacity: 0.35,
    },
    fontScaleValue: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        color: theme.colors.text,
        minWidth: 44,
        textAlign: 'center',
    },
    fontScaleReset: {
        paddingHorizontal: 8,
        paddingVertical: 4,
    },
    fontScaleResetText: {
        ...Typography.default(),
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    // Chat font size preview — styled after the real chat: user bubble on the
    // right (userMessageBackground), agent text plain on the left.
    previewContainer: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
    },
    previewBubble: {
        alignSelf: 'flex-end',
        backgroundColor: theme.colors.userMessageBackground,
        paddingHorizontal: 12,
        borderRadius: 12,
        marginBottom: 8,
        maxWidth: '85%',
    },
    previewUserText: {
        ...Typography.default(),
        color: theme.colors.text,
        marginVertical: 8,
    },
    previewAgentText: {
        ...Typography.default(),
        color: theme.colors.text,
        alignSelf: 'flex-start',
        maxWidth: '85%',
    },
}));