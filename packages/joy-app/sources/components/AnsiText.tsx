// Renders `tmux capture-pane -e` output (ANSI SGR) as styled monospace text.
// Each line is a <Text> block of nested colored spans. Pass the mono font /
// size / lineHeight via `style`; per-span color/weight/etc. layer on top.
import * as React from 'react';
import { Text, type TextStyle } from 'react-native';
import { parseAnsiLines, type AnsiSpan } from '@/utils/ansi';

const DEFAULT_FG = '#d4d4d4';
const DEFAULT_BG = '#0c0c0c';

function spanStyle(s: AnsiSpan): TextStyle {
    // Reverse video swaps fg/bg (filling in the pane defaults when unset).
    const fg = s.reverse ? (s.bg ?? DEFAULT_BG) : (s.fg ?? DEFAULT_FG);
    const bg = s.reverse ? (s.fg ?? DEFAULT_FG) : s.bg;
    return {
        color: fg,
        backgroundColor: bg,
        fontWeight: s.bold ? 'bold' : undefined,
        fontStyle: s.italic ? 'italic' : undefined,
        textDecorationLine: s.underline ? 'underline' : undefined,
        opacity: s.dim ? 0.6 : undefined,
    };
}

export const AnsiText = React.memo(({ text, style }: { text: string; style?: TextStyle }) => {
    const lines = React.useMemo(() => parseAnsiLines(text), [text]);
    return (
        <Text style={style} selectable>
            {lines.map((spans, li) => (
                <Text key={li}>
                    {spans.map((s, si) => (
                        <Text key={si} style={spanStyle(s)}>{s.text}</Text>
                    ))}
                    {li < lines.length - 1 ? '\n' : ''}
                </Text>
            ))}
        </Text>
    );
});
