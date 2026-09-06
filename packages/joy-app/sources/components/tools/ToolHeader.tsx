import * as React from 'react';
import { Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { ToolCall } from '@/sync/typesMessage';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { describeTool } from './toolPresentation';

interface ToolHeaderProps {
    tool: ToolCall;
}

/**
 * Navigation header for the tool detail screen. Reads the same safe
 * presentation facts as the card, so a tool with unvalidated arguments
 * (`input: null`, `parsed_cmd: [null]`) shows its name instead of throwing
 * out of the header render.
 */
export function ToolHeader({ tool }: ToolHeaderProps) {
    const { theme } = useUnistyles();
    const presentation = describeTool(tool, null);
    const icon = presentation.icon
        ? presentation.icon(18, theme.colors.header.tint)
        : <Ionicons name="construct-outline" size={18} color={theme.colors.header.tint} />;

    return (
        <View style={styles.container}>
            <View style={styles.titleContainer}>
                <View style={styles.titleRow}>
                    {icon}
                    <Text style={styles.title} numberOfLines={1}>{presentation.title}</Text>
                </View>
                {presentation.subtitle ? (
                    <Text style={styles.subtitle} numberOfLines={1}>{presentation.subtitle}</Text>
                ) : null}
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        flexGrow: 1,
        flexBasis: 0,
        paddingHorizontal: 4,
    },
    titleContainer: {
        flexDirection: 'column',
        alignItems: 'center',
        flexGrow: 1,
        flexBasis: 0
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    title: {
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text,
        textAlign: 'center',
    },
    subtitle: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        marginTop: 2,
    },
}));
