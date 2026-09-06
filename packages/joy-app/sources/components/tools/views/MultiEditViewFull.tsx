import * as React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { ToolCall } from '@/sync/typesMessage';
import { Metadata } from '@/sync/storageTypes';
import { toolFullViewStyles } from '../ToolFullView';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { t } from '@/text';
import { multiEditPairs } from './MultiEditView';
import { getToolModel } from '@/sync/toolModel';

interface MultiEditViewFullProps {
    tool: ToolCall;
    metadata: Metadata | null;
}

/**
 * Full MultiEdit details. Failed or pending edits are labelled as proposals;
 * the failure reason is rendered by ToolFullView from the model, so it is
 * never lost behind the proposed diffs.
 */
export const MultiEditViewFull = React.memo<MultiEditViewFullProps>(({ tool }) => {
    const edits = multiEditPairs(tool);
    const proposed = getToolModel(tool).outcome !== 'succeeded';

    if (edits.length === 0) {
        return null;
    }

    return (
        <View style={toolFullViewStyles.sectionFullWidth}>
            {proposed ? <Text style={styles.proposedLabel}>{t('tools.outcome.proposed')}</Text> : null}
            {edits.map((edit, index) => (
                <View key={index}>
                    <View style={styles.editHeader}>
                        <Text style={styles.editNumber}>
                            {t('tools.multiEdit.editNumber', { index: index + 1, total: edits.length })}
                        </Text>
                        {edit.replaceAll ? (
                            <View style={styles.replaceAllBadge}>
                                <Text style={styles.replaceAllText}>{t('tools.multiEdit.replaceAll')}</Text>
                            </View>
                        ) : null}
                    </View>
                    <ToolDiffView oldText={edit.oldText} newText={edit.newText} showLineNumbers />
                    {index < edits.length - 1 ? <View style={styles.separator} /> : null}
                </View>
            ))}
        </View>
    );
});

const styles = StyleSheet.create({
    proposedLabel: {
        fontSize: 12,
        color: '#8E8E93',
        paddingHorizontal: 12,
        paddingBottom: 4,
        textTransform: 'uppercase',
        letterSpacing: 0.6,
    },
    editHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 8,
    },
    editNumber: {
        fontSize: 14,
        fontWeight: '600',
        color: '#5856D6',
    },
    replaceAllBadge: {
        backgroundColor: '#5856D6',
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 12,
        marginLeft: 8,
    },
    replaceAllText: {
        fontSize: 12,
        color: '#fff',
        fontWeight: '600',
    },
    separator: {
        height: 1,
        backgroundColor: '#E5E5EA',
        marginVertical: 16,
    },
});
