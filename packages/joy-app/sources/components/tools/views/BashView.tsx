import * as React from 'react';
import { ToolCall } from '@/sync/typesMessage';
import { ToolSectionView } from '../../tools/ToolSectionView';
import { CommandView } from '@/components/CommandView';
import { Metadata } from '@/sync/storageTypes';
import { getToolModel } from '@/sync/toolModel';

export const BashView = React.memo((props: { tool: ToolCall, metadata: Metadata | null }) => {
    const model = getToolModel(props.tool);
    const command = model.command?.command ?? '';
    const error = model.outcome === 'failed' || model.outcome === 'denied' || model.outcome === 'cancelled'
        ? model.errorMessage
        : null;

    return (
        <>
            <ToolSectionView>
                <CommandView
                    command={command}
                    // Don't show output in compact view
                    stdout={null}
                    stderr={null}
                    error={error}
                    hideEmptyOutput
                />
            </ToolSectionView>
        </>
    );
});
