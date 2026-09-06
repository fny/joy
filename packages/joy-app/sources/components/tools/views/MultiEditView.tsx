import * as React from 'react';
import { View, StyleSheet } from 'react-native';
import { ToolSectionView } from '../../tools/ToolSectionView';
import { ToolViewProps } from './_all';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { getToolModel, ToolFileEdit, trimCommonIndent } from '@/sync/toolModel';

/** Every edit of a MultiEdit change, each pair's indentation trimmed jointly. */
export function multiEditPairs(tool: ToolViewProps['tool']): ToolFileEdit[] {
    const edits = getToolModel(tool).fileChanges?.[0]?.edits ?? [];
    return edits.map((edit) => {
        const [oldText, newText] = trimCommonIndent([edit.oldText, edit.newText]);
        return { oldText, newText, replaceAll: edit.replaceAll };
    });
}

export const MultiEditView = React.memo<ToolViewProps>(({ tool }) => {
    const edits = multiEditPairs(tool);

    if (edits.length === 0) {
        return null;
    }

    return (
        <ToolSectionView fullWidth>
            {edits.map((edit, index) => (
                <View key={index}>
                    <ToolDiffView oldText={edit.oldText} newText={edit.newText} />
                    {index < edits.length - 1 ? <View style={styles.separator} /> : null}
                </View>
            ))}
        </ToolSectionView>
    );
});

const styles = StyleSheet.create({
    separator: {
        height: 8,
    },
});
