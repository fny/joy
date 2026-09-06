import * as React from 'react';
import { View, Text, Pressable } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useUnistyles } from 'react-native-unistyles';
import { PierreDiffView } from '@/components/diff/PierreDiffView';
import { useSetting } from '@/sync/storage';
import { t } from '@/text';
import { countUnifiedDiffChanges } from '@/utils/codexUnifiedDiff';
import { getDiffStats } from '@/components/diff/calculateDiff';

interface ToolDiffViewProps {
    /** Pre-built unified-diff patch string. Preferred when available. */
    patch?: string;
    /** Pair used to derive a patch if `patch` isn't supplied. */
    oldText?: string;
    newText?: string;
    /** File name — used for language detection in syntax highlighting. */
    fileName?: string;
    style?: any;
    /** No-op in the new renderer (pierre/diffs always draws line numbers via gutter). Kept for source compat. */
    showLineNumbers?: boolean;
    /** No-op in the new renderer; pierre/diffs uses classic indicators. */
    showPlusMinusSymbols?: boolean;
}

/** +N −M counts for the collapse toggle — from the patch when present,
 *  otherwise from a real line diff of the old/new pair.
 *
 *  The patch count goes through the unified-diff parser's state machine: a
 *  prefix test took every "+++"/"---" for a file header, so an edit replacing
 *  "--before" with "++after" read +0 −0 (#274). The pair count was a length
 *  delta (`newLines - oldLines || newLines`) that printed "+5 −0" for a
 *  one-line change in a five-line file (#21). */
export function diffCounts(patch?: string, oldText?: string, newText?: string): { added: number; removed: number } {
    if (patch) {
        return countUnifiedDiffChanges(patch);
    }
    const stats = getDiffStats(oldText ?? '', newText ?? '');
    return { added: stats.additions, removed: stats.deletions };
}

export const ToolDiffView = React.memo<ToolDiffViewProps>(({
    patch,
    oldText,
    newText,
    fileName,
    style,
    showLineNumbers,
}) => {
    const { theme } = useUnistyles();
    const wrapLines = useSetting('wrapLinesInDiffs');
    const showLineNumbersInToolViews = useSetting('showLineNumbersInToolViews');
    // Expanded by default — the collapse is for taming long scrollback, so it's
    // per-diff local state (mirrors CodexPatchView's per-file chevron).
    const [expanded, setExpanded] = React.useState(true);

    const effectiveFileName = fileName ?? 'file.txt';
    const counts = React.useMemo(() => diffCounts(patch, oldText, newText), [patch, oldText, newText]);

    // Chat tool diffs are always inline unified — the split view lives on the
    // dedicated InlineFileDiff pane (controlled via the diffStyle setting).
    const common = {
        overflow: wrapLines ? ('wrap' as const) : ('scroll' as const),
        disableLineNumbers: !(showLineNumbers ?? showLineNumbersInToolViews),
        disableFileHeader: true,
        diffStyle: 'unified' as const,
    };

    return (
        <View style={[{ flex: 1 }, style]}>
            <Pressable
                onPress={() => setExpanded(v => !v)}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={expanded ? 'Collapse diff' : 'Expand diff'}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4 }}
            >
                <Ionicons name={expanded ? 'chevron-down' : 'chevron-forward'} size={13} color={theme.colors.textSecondary} />
                <Text style={{ fontSize: 12, color: theme.colors.textSecondary }}>
                    {t('toolView.diff')}
                    {'  '}
                    <Text style={{ color: '#34C759' }}>+{counts.added}</Text>
                    {' '}
                    <Text style={{ color: '#FF3B30' }}>−{counts.removed}</Text>
                </Text>
            </Pressable>
            {expanded && (patch ? (
                <PierreDiffView patch={patch} {...common} />
            ) : (
                <PierreDiffView
                    oldFile={{ name: effectiveFileName, contents: oldText ?? '' }}
                    newFile={{ name: effectiveFileName, contents: newText ?? '' }}
                    {...common}
                />
            ))}
        </View>
    );
});
