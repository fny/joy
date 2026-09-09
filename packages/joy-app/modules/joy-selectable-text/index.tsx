import { requireNativeView, requireOptionalNativeModule } from 'expo';
import * as React from 'react';
import { Platform, StyleProp, ViewStyle } from 'react-native';

/** One styled run, mirroring the native `JoyTextSpan` record. */
export type JoyTextSpan = {
    text: string;
    bold?: boolean;
    italic?: boolean;
    code?: boolean;
    url?: string | null;
    highlighted?: boolean;
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
    highlightColor?: string;
};

type NativeProps = {
    spans: JoyTextSpan[];
    textStyle: JoyTextStyle;
    style?: StyleProp<ViewStyle>;
    onContentSizeChange?: (event: { nativeEvent: { height: number } }) => void;
    onLinkPress?: (event: { nativeEvent: { url: string } }) => void;
};

/**
 * Whether the native view is in THIS binary — not merely whether the platform
 * could have it.
 *
 * This was `Platform.OS === 'ios'`, which is a capability claim the platform
 * cannot make. An OTA ships JS to whatever build is installed, and runtime
 * version is the only fence: both the July build (no module) and the September
 * build (module) carry runtime 21, so an update needing native code landed on
 * a binary without it. Fabric does not throw for an unregistered view — it
 * renders an empty box — so every markdown paragraph on iOS silently became
 * zero-height, leaving only the wrapper margins. Blank messages, no error.
 *
 * The module registers the view, so the module's presence IS the test, and
 * requireOptionalNativeModule answers it without throwing. A binary that
 * lacks it now falls back to RN Text automatically instead of rendering
 * nothing and waiting for someone to find the Features toggle.
 */
export const isSelectableTextAvailable =
    Platform.OS === 'ios' && requireOptionalNativeModule('JoySelectableText') != null;

// Resolved lazily, and only once isSelectableTextAvailable has confirmed the
// module is actually present: this file is imported by the shared markdown
// renderer, which also runs on Android and web.
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
