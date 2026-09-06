import React from 'react';
import { View, Text } from 'react-native';
import Octicons from '@expo/vector-icons/Octicons';
import { useSessionGitStatus } from '@/sync/gitStatusResource';
import { GitStatus } from '@/sync/storageTypes';
import { knownLines } from '@/sync/gitStatusModel';
import { useUnistyles } from 'react-native-unistyles';

// Custom hook to check if git status should be shown (always true if git repo exists)
export function useHasMeaningfulGitStatus(sessionId: string): boolean {
    const gitStatus = useSessionGitStatus(sessionId);
    return gitStatus ? gitStatus.lastUpdatedAt > 0 : false;
}

interface GitStatusBadgeProps {
    sessionId: string;
}

export function GitStatusBadge({ sessionId }: GitStatusBadgeProps) {
    const gitStatus = useSessionGitStatus(sessionId);
    const { theme } = useUnistyles();

    // Always show if git repository exists, even without changes
    if (!gitStatus || gitStatus.lastUpdatedAt === 0) {
        return null;
    }

    // Exact counts or nothing: an 'unavailable' side renders no badge rather than "+0".
    const lines = knownLines(gitStatus.unstagedLines);
    const hasLineChanges = !!lines && (lines.added > 0 || lines.removed > 0);

    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, overflow: 'hidden' }}>
            {/* Git icon - always shown */}
            <Octicons
                name="git-branch"
                size={16}
                color={theme.colors.button.secondary.tint}
            />

            {/* Line changes only */}
            {hasLineChanges && lines && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                    {lines.added > 0 && (
                        <Text
                            style={{
                                fontSize: 12,
                                color: theme.colors.gitAddedText,
                                fontWeight: '600',
                            }}
                            numberOfLines={1}
                        >
                            +{lines.added}
                        </Text>
                    )}
                    {lines.removed > 0 && (
                        <Text
                            style={{
                                fontSize: 12,
                                color: theme.colors.gitRemovedText,
                                fontWeight: '600',
                            }}
                            numberOfLines={1}
                        >
                            -{lines.removed}
                        </Text>
                    )}
                </View>
            )}
        </View>
    );
}

function getTotalChangedFiles(status: GitStatus): number {
    return status.modifiedCount + status.untrackedCount + status.stagedCount + status.conflictedCount;
}

function hasMeaningfulChanges(status: GitStatus): boolean {
    // Must have been loaded (lastUpdatedAt > 0) and be dirty and have either file changes or line changes
    const lines = knownLines(status.unstagedLines);
    return status.lastUpdatedAt > 0 && status.isDirty && (
        getTotalChangedFiles(status) > 0 ||
        (!!lines && (lines.added > 0 || lines.removed > 0))
    );
}