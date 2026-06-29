import * as React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';

// A scrollable, chat-window mockup used on the palette settings page. It renders
// purely from the LIVE theme tokens (which the palette page re-skins in place),
// so it tracks whichever palette is being previewed — including chat-only
// surfaces (message bubbles, tool/background-task cards, agent runs) that don't
// appear anywhere else on the settings screen.
export const PalettePreview = React.memo(function PalettePreview() {
    return (
        <View style={styles.window}>
            <View style={styles.header}>
                <View style={styles.onlineDot} />
                <View style={{ flex: 1 }}>
                    <Text style={styles.headerTitle} numberOfLines={1}>lisp-interpreter</Text>
                    <Text style={styles.headerSub} numberOfLines={1}>~/projects/lisp</Text>
                </View>
                <Ionicons name="ellipsis-horizontal" size={18} color={styles.headerSub.color as string} />
            </View>

            <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator>
                <Text style={styles.agentText}>Sure — I&apos;ll build a small Lisp interpreter in JavaScript.</Text>

                <View style={styles.userBubble}>
                    <Text style={styles.userText}>build a lisp interpreter</Text>
                </View>

                <Text style={styles.agentText}>Starting with the tokenizer and a recursive evaluator, then I&apos;ll run the suite.</Text>

                {/* Finished background task run */}
                <View style={styles.card}>
                    <Ionicons name="checkmark-circle" size={20} color={styles.iconGreen.color as string} />
                    <View style={{ flex: 1 }}>
                        <Text style={styles.cardTitle}>Background task · completed</Text>
                        <Text style={styles.cardSub} numberOfLines={1}>node run-tests.js</Text>
                    </View>
                    <Text style={styles.donePill}>done</Text>
                </View>

                {/* Agent run */}
                <View style={styles.card}>
                    <Ionicons name="sparkles" size={18} color={styles.iconAccent.color as string} />
                    <View style={{ flex: 1 }}>
                        <Text style={styles.cardTitle}>Agent · explore parser combinators</Text>
                        <Text style={styles.cardSub} numberOfLines={1}>3 tools · 18.4k tokens</Text>
                    </View>
                    <Ionicons name="checkmark" size={16} color={styles.iconGreen.color as string} />
                </View>

                <Text style={styles.agentText}>Done — it evaluates nested expressions like (+ 1 (* 2 3)).</Text>

                <View style={styles.userBubble}>
                    <Text style={styles.userText}>run the tests</Text>
                </View>

                <Text style={styles.agentText}>All 12 tests passed.</Text>
            </ScrollView>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    window: {
        marginHorizontal: 16,
        marginTop: 12,
        marginBottom: 8,
        height: 320,
        borderRadius: 14,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.groupped.background as string,
        overflow: 'hidden',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 14,
        paddingVertical: 10,
        backgroundColor: theme.colors.header.background,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    onlineDot: {
        width: 9,
        height: 9,
        borderRadius: 5,
        backgroundColor: theme.colors.textLink,
    },
    headerTitle: {
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.text,
    },
    headerSub: {
        fontSize: 11,
        color: theme.colors.textSecondary as string,
    },
    scroll: {
        flex: 1,
    },
    scrollContent: {
        padding: 12,
        gap: 10,
    },
    agentText: {
        alignSelf: 'flex-start',
        maxWidth: '90%',
        fontSize: 14,
        lineHeight: 19,
        color: theme.colors.agentMessageText,
    },
    userBubble: {
        alignSelf: 'flex-end',
        maxWidth: '80%',
        backgroundColor: theme.colors.userMessageBackground,
        borderRadius: 14,
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
    userText: {
        fontSize: 14,
        color: theme.colors.userMessageText,
    },
    card: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
    },
    cardTitle: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.text,
    },
    cardSub: {
        fontSize: 12,
        fontFamily: 'monospace',
        color: theme.colors.agentEventText,
    },
    donePill: {
        fontSize: 11,
        fontWeight: '600',
        color: theme.colors.textSecondary as string,
    },
    iconGreen: {
        color: theme.colors.accents.green,
    },
    iconAccent: {
        color: theme.colors.textLink,
    },
}));
