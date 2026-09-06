import * as React from 'react';
import { Pressable } from 'react-native';
import { DropdownMenu, DropdownMenuItem } from '@expo/ui/jetpack-compose';
import { useSessionQuickActions } from '@/hooks/useSessionQuickActions';
import { Session } from '@/sync/storageTypes';
import { t } from '@/text';

interface SessionActionsNativeMenuProps {
    children: React.ReactNode;
    onAfterArchive?: () => void;
    onAfterDelete?: () => void;
    session: Session;
}

export function SessionActionsNativeMenu({
    children,
    onAfterArchive,
    onAfterDelete,
    session,
}: SessionActionsNativeMenuProps) {
    const {
        archiveSession,
        deleteSession,
        canArchive,
        canCopySessionMetadata,
        canResume,
        copySessionMetadata,
        openDetails,
        restartSession,
    } = useSessionQuickActions(session, {
        onAfterArchive,
        onAfterDelete,
    });

    // The Compose DropdownMenu is CONTROLLED: it reads `expanded` (default
    // false) and its Trigger only renders its children — nothing ever opened
    // the menu (#235). We own the state: a press on the trigger expands it,
    // tapping outside asks to dismiss, and every action closes it first.
    const [expanded, setExpanded] = React.useState(false);
    const close = React.useCallback(() => setExpanded(false), []);
    const run = React.useCallback((action: () => void) => () => {
        close();
        action();
    }, [close]);

    return (
        <DropdownMenu expanded={expanded} onDismissRequest={close}>
            <DropdownMenu.Items>
                <DropdownMenuItem onClick={run(openDetails)}>
                    <DropdownMenuItem.Text>Details</DropdownMenuItem.Text>
                </DropdownMenuItem>
                {canArchive && (
                    <DropdownMenuItem onClick={run(deleteSession)}>
                        <DropdownMenuItem.Text>Delete</DropdownMenuItem.Text>
                    </DropdownMenuItem>
                )}
                {canArchive && (
                    <DropdownMenuItem onClick={run(archiveSession)}>
                        <DropdownMenuItem.Text>Archive</DropdownMenuItem.Text>
                    </DropdownMenuItem>
                )}
                {canResume && (
                    <DropdownMenuItem onClick={run(restartSession)}>
                        <DropdownMenuItem.Text>Resume</DropdownMenuItem.Text>
                    </DropdownMenuItem>
                )}
                {canCopySessionMetadata && (
                    <DropdownMenuItem onClick={run(copySessionMetadata)}>
                        <DropdownMenuItem.Text>{t('sessionInfo.copyMetadata')}</DropdownMenuItem.Text>
                    </DropdownMenuItem>
                )}
            </DropdownMenu.Items>
            <DropdownMenu.Trigger>
                <Pressable accessibilityRole="button" onPress={() => setExpanded(true)}>
                    {children}
                </Pressable>
            </DropdownMenu.Trigger>
        </DropdownMenu>
    );
}
