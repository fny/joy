import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import TextareaAutosize from 'react-textarea-autosize';
import { Typography } from '@/constants/Typography';

export type SupportedKey = 'Enter' | 'Escape' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Tab';

export interface KeyPressEvent {
    key: SupportedKey;
    shiftKey: boolean;
}

export type OnKeyPressCallback = (event: KeyPressEvent) => boolean;

export const MULTI_TEXT_INPUT_FONT_SIZE = 16;
export const MULTI_TEXT_INPUT_LINE_HEIGHT = 22;

export interface TextInputState {
    text: string;
    selection: {
        start: number;
        end: number;
    };
}

export interface MultiTextInputHandle {
    getText: () => string;
    setTextAndSelection: (text: string, selection: { start: number; end: number }) => void;
    focus: () => void;
    blur: () => void;
}

// Either `value` (controlled) or `defaultValue` (uncontrolled) must be set.
// Uncontrolled mode keeps the DOM textarea content out of React's reconciliation
// so keystrokes don't get batched and dropped on a busy main thread.
interface MultiTextInputProps {
    value?: string;
    defaultValue?: string;
    onChangeText?: (text: string) => void;
    placeholder?: string;
    maxHeight?: number;
    fontSize?: number;
    lineHeight?: number;
    paddingTop?: number;
    paddingBottom?: number;
    paddingLeft?: number;
    paddingRight?: number;
    onKeyPress?: OnKeyPressCallback;
    onSelectionChange?: (selection: { start: number; end: number }) => void;
    onStateChange?: (state: TextInputState) => void;
}

export const MultiTextInput = React.forwardRef<MultiTextInputHandle, MultiTextInputProps>((props, ref) => {
    const {
        value,
        defaultValue,
        onChangeText,
        placeholder,
        maxHeight = 120,
        fontSize = MULTI_TEXT_INPUT_FONT_SIZE,
        lineHeight = MULTI_TEXT_INPUT_LINE_HEIGHT,
        onKeyPress,
        onSelectionChange,
        onStateChange
    } = props;

    const isControlled = value !== undefined;
    const { theme } = useUnistyles();
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);

    const maxRows = Math.floor(maxHeight / lineHeight);

    const handleKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (!onKeyPress) return;

        const isComposing = e.nativeEvent.isComposing || (e.nativeEvent as any).isComposing || e.keyCode === 229;
        if (isComposing) {
            return;
        }

        const key = e.key;
        
        // Map browser key names to our normalized format
        let normalizedKey: SupportedKey | null = null;
        
        switch (key) {
            case 'Enter':
                normalizedKey = 'Enter';
                break;
            case 'Escape':
                normalizedKey = 'Escape';
                break;
            case 'ArrowUp':
                normalizedKey = 'ArrowUp';
                break;
            case 'ArrowDown':
                normalizedKey = 'ArrowDown';
                break;
            case 'ArrowLeft':
                normalizedKey = 'ArrowLeft';
                break;
            case 'ArrowRight':
                normalizedKey = 'ArrowRight';
                break;
            case 'Tab':
                normalizedKey = 'Tab';
                break;
        }

        if (normalizedKey) {
            const keyEvent: KeyPressEvent = {
                key: normalizedKey,
                shiftKey: e.shiftKey
            };
            
            const handled = onKeyPress(keyEvent);
            if (handled) {
                e.preventDefault();
            }
        }
    }, [onKeyPress]);

    // Set when React's onChange fired for an imperative update, so the handle
    // does not notify a second time (#232).
    const notifiedByEventRef = React.useRef(false);

    const handleChange = React.useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
        notifiedByEventRef.current = true;
        const text = e.target.value;
        const selection = {
            start: e.target.selectionStart,
            end: e.target.selectionEnd
        };

        onChangeText?.(text);

        if (onStateChange) {
            onStateChange({ text, selection });
        }
        if (onSelectionChange) {
            onSelectionChange(selection);
        }
    }, [onChangeText, onStateChange, onSelectionChange]);

    const handleSelect = React.useCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
        const target = e.target as HTMLTextAreaElement;
        const selection = {
            start: target.selectionStart,
            end: target.selectionEnd
        };

        if (onSelectionChange) {
            onSelectionChange(selection);
        }
        if (onStateChange) {
            onStateChange({ text: target.value, selection });
        }
    }, [onSelectionChange, onStateChange]);

    // Imperative handle for direct control
    React.useImperativeHandle(ref, () => ({
        getText: () => textareaRef.current?.value ?? '',
        setTextAndSelection: (text: string, selection: { start: number; end: number }) => {
            const el = textareaRef.current;
            if (!el) return;
            // Assign through the NATIVE value setter. `el.value = text` goes
            // through React's instrumented setter, which records the new value
            // in its tracker, so the input event below looked like a no-op to
            // React and TextareaAutosize's onChange (its resize hook in
            // uncontrolled mode) never ran: a restored multiline draft stayed
            // one line tall and a cleared long draft kept its height (#232).
            const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
            if (nativeSetter) nativeSetter.call(el, text);
            else el.value = text;
            el.setSelectionRange(selection.start, selection.end);

            // Trigger React's onChange (and the autosize) by dispatching an input event
            notifiedByEventRef.current = false;
            el.dispatchEvent(new Event('input', { bubbles: true }));

            // Notify directly only when the event did not reach React (detached node).
            if (!notifiedByEventRef.current) {
                onChangeText?.(text);
                if (onStateChange) {
                    onStateChange({ text, selection });
                }
                if (onSelectionChange) {
                    onSelectionChange(selection);
                }
            }
        },
        focus: () => {
            textareaRef.current?.focus();
        },
        blur: () => {
            textareaRef.current?.blur();
        }
    }), [onChangeText, onStateChange, onSelectionChange]);

    return (
        <View style={{ width: '100%' }}>
            <TextareaAutosize
                ref={textareaRef}
                style={{
                    width: '100%',
                    padding: '0',
                    fontSize: `${fontSize}px`,
                    color: theme.colors.input.text,
                    border: 'none',
                    outline: 'none',
                    resize: 'none' as const,
                    backgroundColor: 'transparent',
                    fontFamily: Typography.default().fontFamily,
                    lineHeight: `${lineHeight}px`,
                    scrollbarWidth: 'none',
                    paddingTop: props.paddingTop,
                    paddingBottom: props.paddingBottom,
                    paddingLeft: props.paddingLeft,
                    paddingRight: props.paddingRight,
                }}
                placeholder={placeholder}
                {...(isControlled ? { value } : { defaultValue })}
                onChange={handleChange}
                onSelect={handleSelect}
                onKeyDown={handleKeyDown}
                maxRows={maxRows}
                autoCapitalize="sentences"
                autoCorrect="on"
                autoComplete="off"
            />
        </View>
    );
});

MultiTextInput.displayName = 'MultiTextInput';
