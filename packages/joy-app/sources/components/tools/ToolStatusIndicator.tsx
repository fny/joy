import * as React from 'react';
import { View, StyleSheet, ActivityIndicator } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { ToolCall } from '@/sync/typesMessage';
import { getToolModel, ToolOutcome } from '@/sync/toolModel';

interface ToolStatusIndicatorProps {
    tool: ToolCall;
}

export function ToolStatusIndicator({ tool }: ToolStatusIndicatorProps) {
    return (
        <View style={styles.container}>
            <StatusIndicator outcome={getToolModel(tool).outcome} />
        </View>
    );
}

function StatusIndicator({ outcome }: { outcome: ToolOutcome }) {
    switch (outcome) {
        case 'pending':
            return <ActivityIndicator size="small" color="#007AFF" />;
        case 'succeeded':
            return <Ionicons name="checkmark-circle" size={22} color="#34C759" />;
        case 'failed':
            return <Ionicons name="close-circle" size={22} color="#FF3B30" />;
        case 'cancelled':
        case 'denied':
            return <Ionicons name="remove-circle" size={22} color="#8E8E93" />;
        default:
            return null;
    }
}

const styles = StyleSheet.create({
    container: {
        width: 22,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
