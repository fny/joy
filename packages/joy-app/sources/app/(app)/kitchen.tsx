// Kitchen sink: every color token rendered on the REAL components that use it.
//
// Why a page and not a design doc: a static swatch sheet drifts the moment a
// token moves. This screen imports Item/ItemGroup/Switch/StatusDot/Avatar/FAB
// and reads theme.colors directly, so it is always showing the truth.
//
// The FAB previews the Light Owl palette. It PREVIEWS — the user's real
// appearance is restored on blur (same contract as settings/palette.tsx), so
// this screen can never leave the app stuck in a palette nobody chose.
import * as React from 'react';
import { View, Text, TextInput, Appearance } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { StyleSheet, useUnistyles, UnistylesRuntime } from 'react-native-unistyles';
import * as SystemUI from 'expo-system-ui';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Switch } from '@/components/Switch';
import { RoundButton } from '@/components/RoundButton';
import { StatusDot } from '@/components/StatusDot';
import { Avatar } from '@/components/Avatar';
import { FAB } from '@/components/FAB';
import { Typography } from '@/constants/Typography';
import { applyAppearance, applyDarkAppearance } from '@/palettes';
import { storage } from '@/sync/storage';
import { lightTheme, darkTheme } from '@/theme';

const LIGHT_OWL = 'light-owl';

/** Restore whatever the user actually chose on Appearance. Mirrors
 *  settings/palette.tsx — the preview must never outlive the screen. */
function restoreAppearance() {
    const ls = storage.getState().localSettings;
    const pref = ls.themePreference;
    const resolved = pref === 'adaptive'
        ? (Appearance.getColorScheme() === 'dark' ? 'dark' : 'light')
        : pref;
    UnistylesRuntime.setAdaptiveThemes(pref === 'adaptive');
    if (pref !== 'adaptive') UnistylesRuntime.setTheme(pref);
    void SystemUI.setBackgroundColorAsync(
        resolved === 'dark' ? darkTheme.colors.groupped.background as string : lightTheme.colors.groupped.background as string,
    );
    if (resolved === 'dark') applyDarkAppearance(ls.themePaletteDark);
    else applyAppearance(ls.themePalette, ls.customPalette, ls.accentOverrides);
}

export default React.memo(function KitchenScreen() {
    const { theme } = useUnistyles();
    const [owl, setOwl] = React.useState(false);
    const [switchOn, setSwitchOn] = React.useState(true);

    // Leaving the screen always restores — including a swipe-back that never
    // runs the toggle again.
    useFocusEffect(React.useCallback(() => () => restoreAppearance(), []));

    const toggleOwl = React.useCallback(() => {
        const next = !owl;
        setOwl(next);
        if (next) {
            // Light Owl is a LIGHT palette, so force the light theme or the
            // preview would silently do nothing in dark mode. Accents come
            // from the palette itself (no user overrides) so it shows true.
            UnistylesRuntime.setAdaptiveThemes(false);
            UnistylesRuntime.setTheme('light');
            applyAppearance(LIGHT_OWL, null, null);
            void SystemUI.setBackgroundColorAsync('#fbfbfb');
        } else {
            restoreAppearance();
        }
    }, [owl]);

    const accents: { key: keyof typeof theme.colors.accents; label: string }[] = [
        { key: 'blue', label: 'Machines' },
        { key: 'indigo', label: 'Appearance' },
        { key: 'green', label: 'Limits' },
        { key: 'orange', label: 'Backup' },
        { key: 'red', label: 'Danger zone' },
        { key: 'pink', label: 'Voice' },
    ];

    const modes: { key: keyof typeof theme.colors.permission; label: string }[] = [
        { key: 'default', label: 'default' },
        { key: 'plan', label: 'plan' },
        { key: 'acceptEdits', label: 'acceptEdits' },
        { key: 'bypass', label: 'bypass' },
        { key: 'readOnly', label: 'read-only' },
        { key: 'safeYolo', label: 'safe-yolo' },
        { key: 'yolo', label: 'yolo' },
    ];

    return (
        <>
            <ItemList>
                <ItemGroup
                    title="Foundation"
                    footer="Ground, surfaces, text and dividers — a palette rewrites all of these."
                >
                    <Item title="Appearance" subtitle="Theme, palette, identicons" />
                    <Item title="Identicons" detail="Circles" />
                    <Item title="Limits" selected />
                    <Item title="Open relay docs" titleStyle={{ color: theme.colors.textLink }} showChevron={false} />
                </ItemGroup>

                <View style={styles.elevated}>
                    <Text style={styles.elevatedText}>
                        surfaceHigh — the raised level tool cards and markdown blocks sit on.
                    </Text>
                </View>

                <ItemGroup title="Accents" footer="Named icon tints. Set by the palette, each separately overridable in Appearance.">
                    {accents.map((a) => (
                        <Item
                            key={a.key}
                            title={a.label}
                            icon={<Ionicons name="ellipse" size={22} color={theme.colors.accents[a.key]} />}
                            detail={theme.colors.accents[a.key]}
                        />
                    ))}
                </ItemGroup>

                <ItemGroup title="Semantic state" footer="Meaning, not style — these never follow the palette, or 'connected' could come out red.">
                    <Item
                        title="Add delete icon"
                        leftElement={<StatusDot color={theme.colors.status.connected} size={9} />}
                        detail="now"
                        showChevron={false}
                    />
                    <Item
                        title="Icon audit"
                        leftElement={<StatusDot color={theme.colors.status.connecting} isPulsing size={9} />}
                        detail="connecting…"
                        showChevron={false}
                    />
                    <Item
                        title="Relay perimeter"
                        leftElement={<StatusDot color={theme.colors.status.disconnected} size={9} />}
                        detail="1h"
                        titleStyle={{ color: theme.colors.textSecondary }}
                        showChevron={false}
                    />
                    <Item
                        title="Stuck session"
                        leftElement={<StatusDot color={theme.colors.status.error} size={9} />}
                        detail="disk 91%"
                        detailStyle={{ color: theme.colors.warningCritical }}
                        showChevron={false}
                    />
                    <Item title="Delete session" destructive showChevron={false} />
                </ItemGroup>

                <ItemGroup title="Chrome & controls" footer="Switches, buttons, inputs and the identicon avatar.">
                    <Item
                        title="Zen mode"
                        rightElement={<Switch value={switchOn} onValueChange={setSwitchOn} />}
                        showChevron={false}
                    />
                    <Item
                        title="Verbose logging"
                        rightElement={<Switch value={false} onValueChange={() => {}} />}
                        showChevron={false}
                    />
                    <Item
                        title="joy"
                        subtitle="Session avatar at 24px"
                        leftElement={<Avatar id="kitchen-sink-demo" size={24} flavor={null} />}
                        showChevron={false}
                    />
                </ItemGroup>

                <View style={styles.pad}>
                    <TextInput
                        style={styles.input}
                        placeholder="Search sessions…"
                        placeholderTextColor={theme.colors.input.placeholder}
                    />
                    <View style={styles.btnRow}>
                        <RoundButton title="Create" size="normal" onPress={() => {}} />
                        <RoundButton title="Cancel" size="normal" display="inverted" onPress={() => {}} />
                        <RoundButton title="Disabled" size="normal" disabled onPress={() => {}} />
                    </View>
                </View>

                <ItemGroup title="Chat" footer="The conversation surface — your bubble, the agent reply, event lines.">
                    <View style={styles.chat}>
                        <View style={styles.bubble}>
                            <Text style={styles.bubbleText}>how are task counts determined?</Text>
                        </View>
                        <Text style={styles.agent}>
                            From the transcript — the daemon replays launch and complete events, then classifies each one.
                        </Text>
                        <Text style={styles.event}>compacted · 2 shells still running</Text>
                    </View>
                </ItemGroup>

                <ItemGroup title="Callouts" footer="Inline warning and error boxes.">
                    <View style={styles.pad}>
                        <View style={[styles.callout, { backgroundColor: theme.colors.box.warning.background, borderColor: theme.colors.box.warning.border }]}>
                            <Text style={{ color: theme.colors.box.warning.text, fontSize: 13 }}>Disk 91% on faraz-vip</Text>
                        </View>
                        <View style={[styles.callout, { backgroundColor: theme.colors.box.error.background, borderColor: theme.colors.box.error.border }]}>
                            <Text style={{ color: theme.colors.box.error.text, fontSize: 13 }}>
                                The session's input box has stray text — tap to clear and resume
                            </Text>
                        </View>
                    </View>
                </ItemGroup>

                <ItemGroup title="Permissions" footer="Mode chips and the approval buttons.">
                    <View style={styles.pad}>
                        <View style={styles.chips}>
                            {modes.map((m) => (
                                <View key={m.key} style={[styles.chip, { borderColor: theme.colors.permission[m.key] }]}>
                                    <Text style={{ color: theme.colors.permission[m.key], fontSize: 11.5, ...Typography.default('semiBold') }}>
                                        {m.label}
                                    </Text>
                                </View>
                            ))}
                        </View>
                        <View style={styles.btnRow}>
                            {([
                                ['allow', 'Allow'],
                                ['deny', 'Deny'],
                                ['allowAll', 'Allow all'],
                            ] as const).map(([k, label]) => (
                                <View key={k} style={[styles.permBtn, { backgroundColor: theme.colors.permissionButton[k].background }]}>
                                    <Text style={{ color: theme.colors.permissionButton[k].text, fontSize: 13, ...Typography.default('semiBold') }}>
                                        {label}
                                    </Text>
                                </View>
                            ))}
                        </View>
                        <View style={styles.btnRow}>
                            <View style={[styles.permBtn, {
                                backgroundColor: theme.colors.permissionButton.selected.background,
                                borderColor: theme.colors.permissionButton.selected.border,
                                borderWidth: 1,
                            }]}>
                                <Text style={{ color: theme.colors.permissionButton.selected.text, fontSize: 13 }}>Ask every time</Text>
                            </View>
                            <View style={[styles.permBtn, {
                                backgroundColor: theme.colors.permissionButton.inactive.background,
                                borderColor: theme.colors.permissionButton.inactive.border,
                                borderWidth: 1,
                            }]}>
                                <Text style={{ color: theme.colors.permissionButton.inactive.text, fontSize: 13 }}>Never ask</Text>
                            </View>
                        </View>
                    </View>
                </ItemGroup>

                <View style={{ height: 96 }} />
            </ItemList>

            <FAB
                icon={owl ? 'sunny' : 'moon-outline'}
                accessibilityLabel={owl ? 'Back to your theme' : 'Preview Light Owl'}
                onPress={toggleOwl}
            />
        </>
    );
});

const styles = StyleSheet.create((theme) => ({
    elevated: {
        backgroundColor: theme.colors.surfaceHigh,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        borderRadius: 10,
        padding: 12,
        marginHorizontal: 16,
        marginBottom: 8,
    },
    elevatedText: { color: theme.colors.textSecondary, fontSize: 13, ...Typography.default() },
    pad: { paddingHorizontal: 16, paddingVertical: 12, gap: 10 },
    input: {
        backgroundColor: theme.colors.input.background,
        color: theme.colors.input.text,
        borderRadius: 10,
        paddingHorizontal: 13,
        paddingVertical: 11,
        fontSize: 15,
        ...Typography.default(),
    },
    btnRow: { flexDirection: 'row', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
    chat: { padding: 14, gap: 10 },
    bubble: {
        alignSelf: 'flex-end',
        maxWidth: '82%',
        backgroundColor: theme.colors.userMessageBackground,
        borderRadius: 14,
        paddingHorizontal: 13,
        paddingVertical: 9,
    },
    bubbleText: { color: theme.colors.userMessageText, fontSize: 15, ...Typography.default() },
    agent: { color: theme.colors.agentMessageText, fontSize: 15, ...Typography.default() },
    event: { color: theme.colors.agentEventText, fontSize: 12.5, ...Typography.default() },
    callout: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 13, paddingVertical: 10 },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
    chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
    permBtn: { borderRadius: 9, paddingHorizontal: 15, paddingVertical: 8, borderWidth: 1, borderColor: 'transparent' },
}));
