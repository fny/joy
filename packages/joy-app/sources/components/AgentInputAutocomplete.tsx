import * as React from 'react';
import { Platform, Pressable, ScrollView, View, type NativeScrollEvent, type NativeSyntheticEvent, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { scrollOffsetToReveal } from './autocomplete/scrollIntoView';

const MAX_HEIGHT = 320;

interface AgentInputAutocompleteProps {
    suggestions: React.ReactElement[];
    selectedIndex?: number;
    onSelect: (index: number) => void;
    itemHeight: number;
}

// We don't reuse FloatingOverlay here because the dropdown needs a ref on
// its ScrollView so arrow-key navigation can scroll the selected item into
// view when the list exceeds the visible window.
export const AgentInputAutocomplete = React.memo((props: AgentInputAutocompleteProps) => {
    const { suggestions, selectedIndex = -1, onSelect, itemHeight } = props;
    const { theme } = useUnistyles();
    const scrollRef = React.useRef<ScrollView>(null);

    // Native has no readable scrollTop: track the offset from onScroll and the
    // viewport from onLayout, and drive ScrollView.scrollTo. The old code took
    // the DOM branch on native too — getScrollableNode returns a truthy numeric
    // handle there — read undefined scrollTop/clientHeight, and never scrolled
    // the selected suggestion into view (#194).
    const scrollOffsetRef = React.useRef(0);
    const viewportHeightRef = React.useRef(MAX_HEIGHT);
    const handleScroll = React.useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
        scrollOffsetRef.current = e.nativeEvent.contentOffset.y;
    }, []);
    const handleLayout = React.useCallback((e: LayoutChangeEvent) => {
        viewportHeightRef.current = e.nativeEvent.layout.height;
    }, []);

    // Keep the selected item within the visible window when the user
    // arrow-keys through suggestions. itemHeight is enough to compute the
    // target since every row has identical height (the dropdown is fixed
    // pitch).
    React.useEffect(() => {
        if (selectedIndex < 0 || !scrollRef.current) return;
        const itemTop = selectedIndex * itemHeight;
        const view = scrollRef.current as unknown as {
            scrollTo?: (opts: { y: number; animated?: boolean }) => void;
            getScrollableNode?: () => unknown;
        };
        // Web RN exposes the underlying div; we can read scrollTop directly
        // for tighter control. Only a REAL scroll element takes this branch.
        const node = Platform.OS === 'web' ? view.getScrollableNode?.() : null;
        if (node && typeof node === 'object' && typeof (node as HTMLDivElement).scrollTop === 'number') {
            const el = node as HTMLDivElement;
            const target = scrollOffsetToReveal(itemTop, itemHeight, el.scrollTop, el.clientHeight);
            if (target !== null) el.scrollTop = target;
            return;
        }
        const target = scrollOffsetToReveal(itemTop, itemHeight, scrollOffsetRef.current, viewportHeightRef.current);
        if (target !== null) {
            scrollOffsetRef.current = target; // scrollTo is async; a second arrow press must not read the stale offset
            view.scrollTo?.({ y: target, animated: false });
        }
    }, [selectedIndex, itemHeight]);

    if (suggestions.length === 0) {
        return null;
    }

    return (
        <View style={[styles.container, { maxHeight: MAX_HEIGHT }]}>
            <ScrollView
                ref={scrollRef}
                style={{ maxHeight: MAX_HEIGHT }}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={true}
                onScroll={handleScroll}
                scrollEventThrottle={16}
                onLayout={handleLayout}
            >
                {suggestions.map((suggestion, index) => (
                    <Pressable
                        key={index}
                        onPress={() => onSelect(index)}
                        style={({ pressed }) => ({
                            height: itemHeight,
                            backgroundColor: pressed
                                ? theme.colors.surfacePressed
                                : selectedIndex === index
                                    ? theme.colors.surfaceSelected
                                    : 'transparent',
                        })}
                    >
                        {suggestion}
                    </Pressable>
                ))}
            </ScrollView>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        borderRadius: 12,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface,
        borderWidth: Platform.OS === 'web' ? 0 : 0.5,
        borderColor: theme.colors.modal.border,
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 2 },
        shadowRadius: 3.84,
        shadowOpacity: theme.colors.shadow.opacity,
        elevation: 5,
    },
}));