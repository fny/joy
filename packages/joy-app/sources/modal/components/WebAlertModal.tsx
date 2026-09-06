import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { BaseModal } from './BaseModal';
import { AlertModalConfig, ConfirmModalConfig } from '../types';
import { Typography } from '@/constants/Typography';
import { StyleSheet } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { errorMessage, isThenable } from '@/utils/guardAsync';

interface WebAlertModalProps {
    config: AlertModalConfig | ConfirmModalConfig;
    onClose: () => void;
    onConfirm?: (value: boolean) => void;
}

export function WebAlertModal({ config, onClose, onConfirm }: WebAlertModalProps) {
    const { theme } = useUnistyles();
    const isConfirm = config.type === 'confirm';
    // An async button keeps the dialog open (buttons disabled) until it
    // settles: success closes, a rejection is shown inline and the buttons
    // come back so the user can retry or cancel. Before, the dialog closed at
    // once and the rejection escaped unhandled with the retry control gone.
    const [pending, setPending] = React.useState(false);
    const [failure, setFailure] = React.useState<string | null>(null);
    const mounted = React.useRef(true);
    React.useEffect(() => () => { mounted.current = false; }, []);

    const handleButtonPress = (buttonIndex: number) => {
        if (pending) return;
        if (isConfirm && onConfirm) {
            onConfirm(buttonIndex === 1);
            onClose();
            return;
        }
        const onPress = !isConfirm ? config.buttons?.[buttonIndex]?.onPress : undefined;
        if (!onPress) { onClose(); return; }
        let result: unknown;
        try {
            result = onPress();
        } catch (e) {
            setFailure(errorMessage(e));
            return;
        }
        if (!isThenable(result)) { onClose(); return; }
        setPending(true);
        setFailure(null);
        Promise.resolve(result).then(
            () => { if (mounted.current) setPending(false); onClose(); },
            (e) => { if (!mounted.current) return; setPending(false); setFailure(errorMessage(e)); },
        );
    };

    const buttons = isConfirm
        ? [
            { text: config.cancelText || 'Cancel', style: 'cancel' as const },
            { text: config.confirmText || 'OK', style: config.destructive ? 'destructive' as const : 'default' as const }
        ]
        : config.buttons || [{ text: 'OK', style: 'default' as const }];

    // iOS UIAlertController behavior: up to two buttons sit side by side;
    // three or more stack vertically (the session action menu has ~7 —
    // squeezing them into one 270px row produced unreadable slivers).
    const isVertical = buttons.length > 2;

    const styles = StyleSheet.create({
        container: {
            backgroundColor: theme.colors.surface,
            borderRadius: 14,
            width: 270,
            overflow: 'hidden',
            shadowColor: theme.colors.shadow.color,
            shadowOffset: {
                width: 0,
                height: 2
            },
            shadowOpacity: 0.25,
            shadowRadius: 4,
            elevation: 5
        },
        content: {
            paddingHorizontal: 16,
            paddingTop: 20,
            paddingBottom: 16,
            alignItems: 'center'
        },
        title: {
            fontSize: 17,
            textAlign: 'center',
            color: theme.colors.text,
            marginBottom: 4
        },
        message: {
            fontSize: 13,
            textAlign: 'center',
            color: theme.colors.text,
            marginTop: 4,
            lineHeight: 18
        },
        buttonContainer: {
            borderTopWidth: 1,
            borderTopColor: theme.colors.divider,
            flexDirection: isVertical ? 'column' : 'row'
        },
        button: {
            flex: isVertical ? undefined : 1,
            paddingVertical: 11,
            alignItems: 'center',
            justifyContent: 'center'
        },
        buttonPressed: {
            backgroundColor: theme.colors.divider
        },
        buttonSeparator: {
            width: isVertical ? undefined : 1,
            height: isVertical ? 1 : undefined,
            backgroundColor: theme.colors.divider
        },
        buttonText: {
            fontSize: 17,
            color: theme.colors.textLink
        },
        cancelText: {
            fontWeight: '400'
        },
        destructiveText: {
            color: theme.colors.textDestructive
        }
    });

    return (
        <BaseModal visible={true} onClose={onClose} closeOnBackdrop={false}>
            <View style={styles.container}>
                <View style={styles.content}>
                    <Text style={[styles.title, Typography.default('semiBold')]}>
                        {config.title}
                    </Text>
                    {config.message && (
                        <Text style={[styles.message, Typography.default()]}>
                            {config.message}
                        </Text>
                    )}
                    {failure && (
                        <Text style={[styles.message, styles.destructiveText, Typography.default()]} testID="alert-failure">
                            {failure}
                        </Text>
                    )}
                </View>

                <View style={styles.buttonContainer}>
                    {buttons.map((button, index) => (
                        <React.Fragment key={index}>
                            {index > 0 && <View style={styles.buttonSeparator} />}
                            <Pressable
                                style={({ pressed }) => [
                                    styles.button,
                                    pressed && styles.buttonPressed,
                                    pending && { opacity: 0.5 }
                                ]}
                                disabled={pending}
                                onPress={() => handleButtonPress(index)}
                            >
                                <Text style={[
                                    styles.buttonText,
                                    button.style === 'cancel' && styles.cancelText,
                                    button.style === 'destructive' && styles.destructiveText,
                                    Typography.default(button.style === 'cancel' ? undefined : 'semiBold')
                                ]}>
                                    {button.text}
                                </Text>
                            </Pressable>
                        </React.Fragment>
                    ))}
                </View>
            </View>
        </BaseModal>
    );
}