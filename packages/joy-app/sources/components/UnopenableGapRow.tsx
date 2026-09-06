import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';

/**
 * The chat's placeholder for a span of history this device could not
 * decrypt (#128): a small muted row, like an agent event. It is projected
 * from the sync's gap bookkeeping when the chat reads its messages and
 * disappears on its own once the rows open under a corrected key.
 */
export const UnopenableGapRow = React.memo((props: { count: number }) => {
    return (
        <View style={styles.container} testID="unopenable-gap-row">
            <Text style={styles.text}>{t('message.unopenableGap', { count: props.count })}</Text>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        marginHorizontal: 8,
        alignItems: 'center',
        paddingVertical: 8,
    },
    text: {
        color: theme.colors.agentEventText,
        fontSize: 13,
        opacity: 0.8,
        textAlign: 'center',
    },
}));
