import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

const HEX_FULL = /^#[0-9a-fA-F]{6}$/;
const HEX_SHORT = /^#[0-9a-fA-F]{3}$/;

// <input type="color"> needs a full #rrggbb; normalize shorthand/invalid.
function normalize(v: string): string {
    const s = (v || '').trim();
    if (HEX_FULL.test(s)) return s;
    if (HEX_SHORT.test(s)) return '#' + s.slice(1).split('').map((c) => c + c).join('');
    return '#000000';
}

// A color swatch that opens a picker when clicked. On web it's a native
// <input type="color"> (rendered as a real DOM node by react-native-web); on
// native there's no system picker, so it's just the swatch (edit via the hex
// field next to it).
export function ColorBox({ value, onChange, size = 26 }: { value: string; onChange: (hex: string) => void; size?: number }) {
    const styles = stylesheet;
    if (Platform.OS === 'web') {
        return React.createElement('input', {
            type: 'color',
            value: normalize(value),
            onChange: (e: { target: { value: string } }) => onChange(e.target.value),
            'aria-label': 'Pick color',
            style: {
                width: size,
                height: size,
                padding: 0,
                border: 0,
                borderRadius: 6,
                background: 'none',
                cursor: 'pointer',
            },
        } as Record<string, unknown>);
    }
    return <View style={[styles.swatch, { width: size, height: size, backgroundColor: normalize(value) }]} />;
}

const stylesheet = StyleSheet.create((theme) => ({
    swatch: {
        borderRadius: 6,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
}));
