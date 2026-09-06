import React, { useEffect, useRef } from 'react';
import {
    View,
    Modal,
    TouchableWithoutFeedback,
    Animated,
    StyleSheet,
    KeyboardAvoidingView,
    Platform
} from 'react-native';

interface CommandPaletteModalProps {
    visible: boolean;
    onClose?: () => void;
    children: React.ReactNode;
}

const CLOSE_ANIMATION_MS = 150;
/** Small delay so the native Modal is hidden before onClose unmounts us. */
const CLOSE_SETTLE_MS = 50;

/**
 * The palette's animated shell. The mounted/visible state FOLLOWS the
 * `visible` prop (#205): before, the native Modal mounted visible even for
 * `visible=false`, a `true → false` change never hid it, and after a backdrop
 * dismissal a `false → true` change only replayed the animation while the
 * component kept returning null — the palette could not reopen. Every
 * animation completion and close timer is tied to a run id so a stale
 * completion (a reopen during the closing animation, an unmount) is ignored.
 */
export function CommandPaletteModal({
    visible,
    onClose,
    children
}: CommandPaletteModalProps) {
    const fadeAnim = useRef(new Animated.Value(0)).current;
    const scaleAnim = useRef(new Animated.Value(0.95)).current;
    const [isModalVisible, setIsModalVisible] = React.useState(visible);
    // Bumped on every open/close transition; async completions compare
    // against it and bail when superseded.
    const runRef = useRef(0);
    const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    const clearCloseTimer = React.useCallback(() => {
        if (closeTimerRef.current !== null) {
            clearTimeout(closeTimerRef.current);
            closeTimerRef.current = null;
        }
    }, []);

    const animateOpen = React.useCallback(() => {
        // Bumping the run id retires any in-flight close completion/timer so a
        // reopen during the closing animation cannot be hidden by it.
        runRef.current++;
        clearCloseTimer();
        fadeAnim.stopAnimation();
        scaleAnim.stopAnimation();
        setIsModalVisible(true);
        Animated.parallel([
            Animated.timing(fadeAnim, {
                toValue: 1,
                duration: 200,
                useNativeDriver: true
            }),
            Animated.spring(scaleAnim, {
                toValue: 1,
                friction: 10,
                tension: 60,
                useNativeDriver: true
            })
        ]).start();
    }, [fadeAnim, scaleAnim, clearCloseTimer]);

    /** Play the closing animation, hide the Modal, then (optionally) tell the
     *  owner. Superseded by any later open/close. */
    const animateClose = React.useCallback((notifyOwner: boolean) => {
        const run = ++runRef.current;
        clearCloseTimer();
        fadeAnim.stopAnimation();
        scaleAnim.stopAnimation();
        Animated.parallel([
            Animated.timing(fadeAnim, {
                toValue: 0,
                duration: CLOSE_ANIMATION_MS,
                useNativeDriver: true
            }),
            Animated.timing(scaleAnim, {
                toValue: 0.95,
                duration: CLOSE_ANIMATION_MS,
                useNativeDriver: true
            })
        ]).start(() => {
            if (run !== runRef.current) return;
            setIsModalVisible(false);
            if (!notifyOwner) return;
            closeTimerRef.current = setTimeout(() => {
                closeTimerRef.current = null;
                if (run !== runRef.current) return;
                onCloseRef.current?.();
            }, CLOSE_SETTLE_MS);
        });
    }, [fadeAnim, scaleAnim, clearCloseTimer]);

    // Follow the controlled prop: open on every rising edge, close (with the
    // exit animation) on every falling edge. The owner already knows about a
    // prop-driven close, so it is not notified again.
    const firstRenderRef = useRef(true);
    useEffect(() => {
        if (visible) {
            animateOpen();
        } else if (!firstRenderRef.current) {
            animateClose(false);
        }
        firstRenderRef.current = false;
    }, [visible, animateOpen, animateClose]);

    // Unmount: no completion may touch state or call onClose afterwards.
    useEffect(() => () => {
        runRef.current++;
        clearCloseTimer();
        fadeAnim.stopAnimation();
        scaleAnim.stopAnimation();
    }, [clearCloseTimer, fadeAnim, scaleAnim]);

    // Backdrop / hardware back / Escape: the modal closes ITSELF and then
    // notifies the owner so it can drop the palette from the modal stack.
    const handleClose = React.useCallback(() => {
        animateClose(true);
    }, [animateClose]);

    const handleBackdropPress = () => {
        handleClose();
    };

    if (!isModalVisible) {
        return null;
    }

    return (
        <Modal
            visible={isModalVisible}
            transparent={true}
            animationType="none"
            onRequestClose={handleClose}
        >
            <KeyboardAvoidingView
                style={styles.container}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            >
                <TouchableWithoutFeedback onPress={handleBackdropPress}>
                    <Animated.View
                        style={[
                            styles.backdrop,
                            {
                                opacity: fadeAnim.interpolate({
                                    inputRange: [0, 1],
                                    outputRange: [0, 0.7]
                                })
                            }
                        ]}
                    />
                </TouchableWithoutFeedback>

                <Animated.View
                    style={[
                        styles.content,
                        {
                            opacity: fadeAnim,
                            transform: [{ scale: scaleAnim }]
                        }
                    ]}
                >
                    {children}
                </Animated.View>
            </KeyboardAvoidingView>
        </Modal>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        justifyContent: 'flex-start',
        alignItems: 'center',
        // Position at 30% from top of viewport
        ...(Platform.OS === 'web' ? {
            paddingTop: '30vh',
        } as any : {
            paddingTop: 200, // Fallback for native
        })
    },
    backdrop: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(15, 15, 15, 0.75)',
        // Remove blur for better performance - use darker overlay instead
        // Blur can be re-enabled if needed but with optimizations
        ...(Platform.OS === 'web' ? {
            // backdropFilter: 'blur(2px)',
            // WebkitBackdropFilter: 'blur(2px)',
            // willChange: 'backdrop-filter',
            // transform: 'translateZ(0)', // Force GPU acceleration
        } as any : {})
    },
    content: {
        zIndex: 1,
        width: '90%',
        maxWidth: 800, // Increased from 640
    }
});
