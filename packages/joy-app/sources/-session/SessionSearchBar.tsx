import * as React from 'react';
import { View, TextInput, Pressable, Platform } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { useSessionMessages } from '@/sync/storage';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

export interface SessionSearchBarProps {
    sessionId: string;
    /** Scroll the chat to a message; false = not in the loaded window. */
    onScrollToMessage: (messageId: string) => boolean;
    onClose: () => void;
}

/** A single searchable match: the message id (for scrolling) and a text
 *  snippet centered on the hit (for the result preview). */
interface Match {
    messageId: string;
    snippet: string;
}

function buildSnippet(text: string, at: number, queryLen: number): string {
    const start = Math.max(0, at - 24);
    const end = Math.min(text.length, at + queryLen + 24);
    return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
}

export const SessionSearchBar = React.memo((props: SessionSearchBarProps) => {
    const { theme } = useUnistyles();
    const { messages } = useSessionMessages(props.sessionId);
    const [query, setQuery] = React.useState('');
    const [current, setCurrent] = React.useState(0);
    const inputRef = React.useRef<TextInput>(null);

    React.useEffect(() => {
        // Autofocus the field when the bar opens.
        const t = setTimeout(() => inputRef.current?.focus(), 30);
        return () => clearTimeout(t);
    }, []);

    // Matches over the LOADED window only (older history pages in on scroll).
    // messages carry text on user-text / agent-text kinds.
    const matches = React.useMemo<Match[]>(() => {
        const q = query.trim().toLowerCase();
        if (!q) return [];
        const out: Match[] = [];
        for (const m of messages) {
            const text = (m.kind === 'user-text' || m.kind === 'agent-text') ? (m.kind === 'user-text' ? (m.displayText ?? m.text) : m.text) : '';
            if (!text) continue;
            const at = text.toLowerCase().indexOf(q);
            if (at >= 0) out.push({ messageId: m.id, snippet: buildSnippet(text, at, q.length) });
        }
        return out;
    }, [messages, query]);

    // Reset the cursor + jump to the first hit whenever the query changes.
    React.useEffect(() => {
        setCurrent(0);
        if (matches.length > 0) props.onScrollToMessage(matches[0].messageId);
    }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

    const go = React.useCallback((dir: 1 | -1) => {
        if (matches.length === 0) return;
        const next = (current + dir + matches.length) % matches.length;
        setCurrent(next);
        props.onScrollToMessage(matches[next].messageId);
    }, [matches, current, props]);

    const onKeyPress = React.useCallback((e: any) => {
        const key = e?.nativeEvent?.key;
        if (key === 'Enter') { e.preventDefault?.(); go(e?.nativeEvent?.shiftKey ? -1 : 1); }
        else if (key === 'Escape') { e.preventDefault?.(); props.onClose(); }
    }, [go, props]);

    const hasQuery = query.trim().length > 0;
    const countLabel = !hasQuery ? '' : matches.length === 0 ? 'No results' : `${current + 1}/${matches.length}`;

    return (
        <View style={styles.container}>
            <Ionicons name="search" size={16} color={theme.colors.textSecondary} style={{ marginRight: 6 }} />
            <TextInput
                ref={inputRef}
                value={query}
                onChangeText={setQuery}
                onKeyPress={onKeyPress}
                placeholder="Search this session"
                placeholderTextColor={theme.colors.input.placeholder}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
                returnKeyType="search"
            />
            {!!countLabel && (
                <Text style={[styles.count, matches.length === 0 && hasQuery && { color: theme.colors.textDestructive }]}>
                    {countLabel}
                </Text>
            )}
            <Pressable onPress={() => go(-1)} disabled={matches.length === 0} hitSlop={6} style={styles.iconBtn}>
                <Ionicons name="chevron-up" size={18} color={matches.length ? theme.colors.text : theme.colors.textSecondary} />
            </Pressable>
            <Pressable onPress={() => go(1)} disabled={matches.length === 0} hitSlop={6} style={styles.iconBtn}>
                <Ionicons name="chevron-down" size={18} color={matches.length ? theme.colors.text : theme.colors.textSecondary} />
            </Pressable>
            <Pressable onPress={props.onClose} hitSlop={6} style={styles.iconBtn}>
                <Ionicons name="close" size={18} color={theme.colors.text} />
            </Pressable>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.surfaceHigh ?? theme.colors.surface,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        paddingHorizontal: 10,
        paddingVertical: 6,
        gap: 2,
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.15,
        shadowRadius: 8,
        elevation: 4,
        ...(Platform.OS === 'web' ? { maxWidth: 420 } : {}),
    },
    input: {
        flex: 1,
        minWidth: 140,
        ...Typography.default(),
        fontSize: 14,
        color: theme.colors.input.text,
        paddingVertical: 2,
        ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
    },
    count: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginHorizontal: 6,
        minWidth: 36,
        textAlign: 'right',
    },
    iconBtn: {
        width: 28,
        height: 28,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 6,
    },
}));
