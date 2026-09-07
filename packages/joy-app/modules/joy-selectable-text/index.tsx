import { requireNativeView } from 'expo';
import * as React from 'react';
import { Platform, StyleProp, ViewStyle } from 'react-native';

/** One styled run, mirroring the native `JoyTextSpan` record. */
export type JoyTextSpan = {
    text: string;
    bold?: boolean;
    italic?: boolean;
    code?: boolean;
    url?: string | null;
};

/** Fonts and colours resolved on the JS side from the theme + chat font scale. */
export type JoyTextStyle = {
    fontFamily: string;
    fontFamilyBold?: string;
    fontFamilyItalic?: string;
    fontFamilyMono?: string;
    fontSize: number;
    lineHeight: number;
    color: string;
    linkColor: string;
    codeColor?: string;
    codeBackgroundColor?: string;
};

type NativeProps = {
    spans: JoyTextSpan[];
    textStyle: JoyTextStyle;
    style?: StyleProp<ViewStyle>;
    onContentSizeChange?: (event: { nativeEvent: { height: number } }) => void;
    onLinkPress?: (event: { nativeEvent: { url: string } }) => void;
};

/** Whether the native view exists on this platform. iOS only — see the module. */
export const isSelectableTextAvailable = Platform.OS === 'ios';

// Resolved lazily: requireNativeView throws on a platform where the view was
// never registered, and this module is imported from the shared markdown
// renderer that also runs on Android and web.
let NativeView: React.ComponentType<NativeProps> | null = null;
function getNativeView(): React.ComponentType<NativeProps> | null {
    if (!isSelectableTextAvailable) return null;
    if (!NativeView) {
        NativeView = requireNativeView<NativeProps>('JoySelectableText');
    }
    return NativeView;
}

export type SelectableTextProps = {
    spans: JoyTextSpan[];
    textStyle: JoyTextStyle;
    style?: StyleProp<ViewStyle>;
    onLinkPress?: (url: string) => void;
};

/**
 * Text you can actually select a phrase out of, on iOS.
 *
 * The height comes back from native (only UITextView knows how the attributed
 * string wrapped at this width) and is applied here, so the view occupies the
 * right space in the surrounding Yoga layout. Until the first measurement
 * arrives the view has no height, which is one frame — the same frame RN's own
 * text would have spent measuring.
 */
export function SelectableText(props: SelectableTextProps) {
    const View = getNativeView();
    const [height, setHeight] = React.useState<number | null>(null);
    const { onLinkPress } = props;

    const handleContentSizeChange = React.useCallback(
        (event: { nativeEvent: { height: number } }) => setHeight(event.nativeEvent.height),
        [],
    );
    const handleLinkPress = React.useCallback(
        (event: { nativeEvent: { url: string } }) => onLinkPress?.(event.nativeEvent.url),
        [onLinkPress],
    );

    if (!View) return null;

    return (
        <View
            spans={props.spans}
            textStyle={props.textStyle}
            style={[props.style, height == null ? null : { height }]}
            onContentSizeChange={handleContentSizeChange}
            onLinkPress={handleLinkPress}
        />
    );
}
