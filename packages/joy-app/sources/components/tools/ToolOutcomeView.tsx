import * as React from 'react';
import { Image, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { CodeView } from '@/components/CodeView';
import { ToolError } from './ToolError';
import { ToolSectionView } from './ToolSectionView';
import { safeStringify, ToolCallModel, ToolResultBlock } from '@/sync/toolModel';
import { t } from '@/text';

interface ToolOutcomeViewProps {
    model: ToolCallModel;
    /** `compact` shows failures only; `full` also renders the result blocks. */
    mode: 'compact' | 'full';
    /** Wrap the output blocks in a titled section (default in full mode). */
    titled?: boolean;
}

/**
 * The ONE result / error presenter every tool surface uses. It reads only the
 * canonical model: a failure shows its extracted reason (a structured
 * `{error}` object never becomes "[object Object]"), a denial or interruption
 * shows as a muted notice rather than a red error, and a successful result
 * renders EVERY block in order — text, images and structured values, including
 * a zero, `false` or empty-string result, none of which is "no output".
 */
export const ToolOutcomeView = React.memo<ToolOutcomeViewProps>(({ model, mode, titled }) => {
    if (model.outcome === 'failed' || model.outcome === 'denied' || model.outcome === 'cancelled') {
        const message = model.errorMessage ?? outcomeFallback(model.outcome);
        return (
            <ToolError
                message={message}
                tone={model.outcome === 'failed' ? 'error' : 'muted'}
                label={model.outcome === 'failed' ? null : outcomeFallback(model.outcome)}
            />
        );
    }
    if (mode !== 'full' || model.outcome !== 'succeeded' || model.blocks.length === 0) {
        return null;
    }
    const body = (
        <View style={styles.blocks}>
            {model.blocks.map((block, index) => (
                <ToolResultBlockView key={index} block={block} />
            ))}
        </View>
    );
    if (titled === false) {
        return body;
    }
    return <ToolSectionView title={t('toolView.output')}>{body}</ToolSectionView>;
});

function outcomeFallback(outcome: 'failed' | 'denied' | 'cancelled'): string {
    switch (outcome) {
        case 'failed':
            return t('tools.outcome.failed');
        case 'denied':
            return t('tools.outcome.denied');
        case 'cancelled':
            return t('tools.outcome.cancelled');
    }
}

const ToolResultBlockView = React.memo<{ block: ToolResultBlock }>(({ block }) => {
    if (block.kind === 'text') {
        return <CodeView code={block.text} />;
    }
    if (block.kind === 'image') {
        const uri = block.url ?? (block.data ? `data:${block.mediaType ?? 'image/png'};base64,${block.data}` : null);
        if (!uri) {
            return <Text style={styles.imagePlaceholder}>{t('tools.outcome.image')}</Text>;
        }
        return <Image source={{ uri }} style={styles.image} resizeMode="contain" accessibilityLabel={t('tools.outcome.image')} />;
    }
    return <CodeView code={safeStringify(block.value)} />;
});

const styles = StyleSheet.create((theme) => ({
    blocks: {
        gap: 8,
    },
    image: {
        width: '100%',
        height: 240,
        borderRadius: 6,
        backgroundColor: theme.colors.surfaceHigh,
    },
    imagePlaceholder: {
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
}));
