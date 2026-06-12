// Renders `tmux capture-pane -e` output (ANSI SGR) as styled monospace text.
// Each line is a <Text> block of nested colored spans. Pass the mono font /
// size / lineHeight via `style`; per-span color/weight/etc. layer on top.
import * as React from 'react';
import { Text, type TextStyle } from 'react-native';
import { parseAnsiLines, type AnsiSpan } from '@/utils/ansi';
import { useLocalSetting } from '@/sync/storage';
import { resolveTerminalTheme } from '@/constants/terminalThemes';

function spanStyle(s: AnsiSpan, defaultFg: string, defaultBg: string): TextStyle {
    // Reverse video swaps fg/bg (filling in the pane defaults when unset).
    const fg = s.reverse ? (s.bg ?? defaultBg) : (s.fg ?? defaultFg);
    const bg = s.reverse ? (s.fg ?? defaultFg) : s.bg;
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
    const terminalThemeId = useLocalSetting('terminalTheme');
    const tt = React.useMemo(() => resolveTerminalTheme(terminalThemeId), [terminalThemeId]);
    // Re-parse when the palette changes, not just the text.
    const lines = React.useMemo(() => parseAnsiLines(text, tt.ansi), [text, tt]);
    return (
        <Text style={[{ color: tt.foreground, backgroundColor: tt.background }, style]} selectable>
            {lines.map((spans, li) => (
                <Text key={li}>
                    {spans.map((s, si) => (
                        <Text key={si} style={spanStyle(s, tt.foreground, tt.background)}>{s.text}</Text>
                    ))}
                    {li < lines.length - 1 ? '\n' : ''}
                </Text>
            ))}
        </Text>
    );
});
