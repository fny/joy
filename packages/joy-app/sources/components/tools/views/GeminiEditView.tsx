import * as React from 'react';
import { ToolSectionView } from '../../tools/ToolSectionView';
import { ToolViewProps } from './_all';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { useSetting } from '@/sync/storage';
import { editPair } from './EditView';

/**
 * Gemini Edit View.
 *
 * Gemini ships the edit in one of three nestings (`toolCall.content[0]`,
 * `input[0]`, or direct `oldText` / `newText` / `path`). The canonical model
 * reads all of them and validates the texts as strings, so a non-string
 * payload (`{text: 'before'}`, `17`) renders an empty diff instead of throwing
 * in `split`.
 */
export const GeminiEditView = React.memo<ToolViewProps>(({ tool }) => {
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
