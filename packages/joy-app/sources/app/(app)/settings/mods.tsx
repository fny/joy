// Mods catalog: every mod from the repo's mods/ directory (00-17) plus the
// joy-era features added after happy-app was forked into joy-app. Toggleable
// mods keep their switches; everything else is listed so the page is the one
// place to see what this build changes vs stock happy.
//
// Personal-build dev page — plain strings, no i18n (matches the /joy pages).
import * as React from 'react';
import { Switch } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable } from '@/sync/storage';
import { useRouter } from 'expo-router';
import { Modal } from '@/modal';

export default React.memo(function ModsSettingsScreen() {
    const router = useRouter();
    const [chatHistoryLimit, setChatHistoryLimit] = useSettingMutable('joy__chatHistoryLimit');
    const [modDoubleTapEnabled, setModDoubleTapEnabled] = useSettingMutable('joy__doubleTapEnabled');
    const [modReadOpenFileEnabled, setModReadOpenFileEnabled] = useSettingMutable('joy__readOpenFileEnabled');

    const handleChatHistoryLimit = React.useCallback(async () => {
        const value = await Modal.prompt(
            'Chat history limit',
            'Max messages rendered per conversation. Empty to disable.',
            {
                defaultValue: chatHistoryLimit != null ? String(chatHistoryLimit) : '',
                placeholder: 'e.g. 100',
            }
        );
        if (value === null) return;
        const trimmed = value.trim();
        if (trimmed === '') {
            setChatHistoryLimit(null);
        } else {
            const parsed = parseInt(trimmed, 10);
            if (!isNaN(parsed) && parsed > 0) {
                setChatHistoryLimit(parsed);
            }
        }
    }, [chatHistoryLimit, setChatHistoryLimit]);

    const toggle = (value: boolean, set: (v: boolean) => void) => (
        <Switch value={value} onValueChange={set} />
    );

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup title="Toggles" footer="Mods that can be switched on and off.">
                <Item
                    title="06 · Chat history limit"
                    subtitle="Caps messages rendered per conversation"
                    detail={chatHistoryLimit != null ? `${chatHistoryLimit}` : 'off'}
                    onPress={handleChatHistoryLimit}
                />
                <Item
                    title="07 · Double tap"
                    subtitle="Second tap within 2s required to commit choice selections"
                    rightElement={toggle(!!modDoubleTapEnabled, setModDoubleTapEnabled)}
                    onPress={() => setModDoubleTapEnabled(!modDoubleTapEnabled)}
                    showChevron={false}
                />
                <Item
                    title="08 · Read → Open file"
                    subtitle="Read tool calls get an Open File button into the file viewer"
                    rightElement={toggle(!!modReadOpenFileEnabled, setModReadOpenFileEnabled)}
                    onPress={() => setModReadOpenFileEnabled(!modReadOpenFileEnabled)}
                    showChevron={false}
                />
            </ItemGroup>

            <ItemGroup title="Always on" footer="Baked-in mods with no toggle.">
                <Item title="00 · joy App" subtitle="Separate app identifier + icon from stock Joy" showChevron={false} />
                <Item title="01 · Mods page" subtitle="This page (replaces the old Personal page)" showChevron={false} />
                <Item title="02 · Audio" subtitle="macOS microphone entitlement for voice in the Tauri build" showChevron={false} />
                <Item title="09 · Dev tools" subtitle="WebKit inspector enabled in release Tauri builds" showChevron={false} />
                <Item title="10 · Component info in DOM" subtitle="data-component/data-source attributes on web dev builds" showChevron={false} />
                <Item title="11 · Unread green dot" subtitle="Unread indicator uses green instead of blue" showChevron={false} />
                <Item title="12 · Keep on top" subtitle="Window > Keep on Top toggle in the macOS menu bar" showChevron={false} />
                <Item
                    title="14 · Raw settings"
                    subtitle="View and edit the raw settings JSON"
                    icon={<Ionicons name="code-slash-outline" size={29} color="#8E8E93" />}
                    onPress={() => router.push('/settings/raw')}
                />
                <Item
                    title="15 · Joy sessions page"
                    subtitle="Manage joy-tmux sessions, daemon status, previous sessions"
                    icon={<Ionicons name="terminal-outline" size={29} color="#8E8E93" />}
                    onPress={() => router.push('/settings/joy-sessions')}
                />
                <Item title="16 · Session indicator" subtitle=">_ badge + session id on joy-tmux sessions" showChevron={false} />
                <Item title="17 · Joy HTTP debug page" subtitle="joy-tmux's local web debug UI on port 4997" showChevron={false} />
            </ItemGroup>

            <ItemGroup title="Joy features" footer="Added after happy-app was forked into joy-app — no longer tracked as mods.">
                <Item
                    title="New session"
                    subtitle="Claude-only session creation: mode, fallback, fork, chrome, extra args"
                    icon={<Ionicons name="add-circle-outline" size={29} color="#8E8E93" />}
                    onPress={() => router.push('/joy/new')}
                />
                <Item
                    title="Interactive terminal"
                    subtitle={'Live pane view + raw key tokens: git commit<Enter><C-c>, <ctrl+shift+a>…'}
                    showChevron={false}
                />
                <Item
                    title="Model catalog"
                    subtitle="opus 4.8 / fable 5 at create and via /model switching"
                    showChevron={false}
                />
                <Item
                    title="Mode switching"
                    subtitle="Footer-verified Shift+Tab cycle: yolo → auto → default → accept edits → plan"
                    showChevron={false}
                />
                <Item
                    title="Image attachments"
                    subtitle="Pasted images written into the session cwd as paste-*.png"
                    showChevron={false}
                />
                <Item
                    title="Restart session"
                    subtitle="Joy sessions: kill the tmux window, resume the conversation fresh"
                    showChevron={false}
                />
                <Item
                    title="Usage analytics"
                    subtitle="Usage by machine, project, model, activity, session"
                    icon={<Ionicons name="flame-outline" size={29} color="#8E8E93" />}
                    onPress={() => router.push('/settings/usage')}
                />
            </ItemGroup>
        </ItemList>
    );
});
