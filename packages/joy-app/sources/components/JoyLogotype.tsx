import * as React from 'react';
import { Text, type TextStyle } from 'react-native';
import { getMonoFont } from '@/constants/Typography';

// ASCII-art "joy" wordmark in Unicode block elements, rendered as monospace
// text instead of the bitmap logotype. lineHeight is locked to fontSize so the
// half-block glyphs (▀ ▄) tile vertically into continuous shapes; any leading
// would split them apart.
const ART = [
    '                     ▄▄ ',
    '   ██ ▄████▄ ██  ██  ██ ',
    '   ██ ██  ██  ▀██▀   ██ ',
    '████▀ ▀████▀   ██    ▄▄ ',
    '                        ',
].join('\n');

export const JoyLogotype = React.memo(({ size = 12, color }: { size?: number; color?: string }) => {
    const style: TextStyle = {
        fontFamily: getMonoFont(),
        fontSize: size,
        lineHeight: size,
        color,
        // Keep the grid exact across platforms.
        includeFontPadding: false,
        textAlignVertical: 'center',
    };
    return (
        <Text
            style={style}
            allowFontScaling={false}
            selectable={false}
            accessibilityLabel="joy"
        >
            {ART}
        </Text>
    );
});
