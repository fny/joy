import * as React from 'react';
import { ToolSectionView } from '../../tools/ToolSectionView';
import { ToolViewProps } from './_all';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { useSetting } from '@/sync/storage';
import { getToolModel, trimCommonIndent } from '@/sync/toolModel';

/** The single edit of an Edit-family change, indentation trimmed JOINTLY. */
export function editPair(tool: ToolViewProps['tool']): { oldText: string; newText: string } | null {
    const change = getToolModel(tool).fileChanges?.[0];
    if (!change) return null;
    const edit = change.edits?.[0] ?? (change.oldText !== null || change.newText !== null
        ? { oldText: change.oldText ?? '', newText: change.newText ?? '' }
        : null);
    if (!edit) return null;
    const [oldText, newText] = trimCommonIndent([edit.oldText, edit.newText]);
    return { oldText, newText };
}

export const EditView = React.memo<ToolViewProps>(({ tool }) => {
    const showLineNumbersInToolViews = useSetting('showLineNumbersInToolViews');
    const pair = editPair(tool);

    return (
        <>
            <ToolSectionView fullWidth>
                <ToolDiffView
                    oldText={pair?.oldText ?? ''}
                    newText={pair?.newText ?? ''}
                    showLineNumbers={showLineNumbersInToolViews}
                    showPlusMinusSymbols={showLineNumbersInToolViews}
                />
            </ToolSectionView>
        </>
    );
});
