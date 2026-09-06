import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { ToolCall } from '@/sync/typesMessage';
import { Metadata } from '@/sync/storageTypes';
import { toolFullViewStyles } from '../ToolFullView';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { editPair } from './EditView';
import { getToolModel } from '@/sync/toolModel';
import { t } from '@/text';

interface EditViewFullProps {
    tool: ToolCall;
    metadata: Metadata | null;
}

/**
 * Full Edit details. A failed or pending edit labels its diff as a PROPOSAL;
 * the failure reason itself is rendered by ToolFullView from the model.
 */
export const EditViewFull = React.memo<EditViewFullProps>(({ tool }) => {
    const model = getToolModel(tool);
    const pair = editPair(tool);
    const proposed = model.outcome !== 'succeeded';

    return (
        <View style={toolFullViewStyles.sectionFullWidth}>
            {proposed ? <Text style={styles.proposedLabel}>{t('tools.outcome.proposed')}</Text> : null}
            <ToolDiffView
                oldText={pair?.oldText ?? ''}
                newText={pair?.newText ?? ''}
                style={{ width: '100%' }}
                showLineNumbers={true}
                showPlusMinusSymbols={true}
            />
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    proposedLabel: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        paddingHorizontal: 12,
        paddingBottom: 4,
        textTransform: 'uppercase',
        letterSpacing: 0.6,
    },
}));
