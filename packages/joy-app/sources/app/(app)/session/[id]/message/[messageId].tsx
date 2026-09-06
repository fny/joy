import * as React from 'react';
import { useLocalSearchParams, Stack, useRouter } from "expo-router";
import { Text, View, ActivityIndicator, Pressable } from "react-native";
import { useMessage, useSession, useSessionMessages } from "@/sync/storage";
import { sync } from '@/sync/sync';
import { isDemoSession } from '@/sync/demoSession';
import { useDemoSession } from '@/hooks/useDemoSession';
import { Deferred } from "@/components/Deferred";
import { ToolFullView } from '@/components/tools/ToolFullView';
import { ToolHeader } from '@/components/tools/ToolHeader';
import { ToolStatusIndicator } from '@/components/tools/ToolStatusIndicator';
import { Message } from '@/sync/typesMessage';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { deepLinkStep, deepLinkTarget } from '@/utils/messageDeepLink';
import { errorMessage } from '@/utils/guardAsync';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    fullViewContainer: {
        flex: 1,
        padding: 16,
    },
    messageText: {
        color: theme.colors.text,
        fontSize: 16,
        lineHeight: 24,
        ...Typography.default(),
    },
    pagingError: {
        color: theme.colors.textSecondary,
        fontSize: 14,
        textAlign: 'center',
        paddingHorizontal: 24,
        ...Typography.default(),
    },
    retryText: {
        color: theme.colors.textLink,
        fontSize: 16,
        marginTop: 12,
        ...Typography.default('semiBold'),
    },
}));

export default React.memo(() => {
    const { id: sessionId, messageId } = useLocalSearchParams<{ id: string; messageId: string }>();
    const router = useRouter();
    // Inject demo fixtures (session + messages) so the demo session's message
    // pages render even when opened directly.
    useDemoSession(isDemoSession(sessionId));
    const session = useSession(sessionId!);
    const { isLoaded: messagesLoaded, hasMoreOlder, isLoadingOlder } = useSessionMessages(sessionId!);
    const message = useMessage(sessionId!, messageId!);
    const { theme } = useUnistyles();
    const styles = stylesheet;
    
    // Trigger session visibility when component mounts
    React.useEffect(() => {
        if (sessionId) {
            sync.onSessionVisible(sessionId);
        }
    }, [sessionId]);
    
    // The first loaded page is only the most recent window of history; a
    // link to an older message is not "missing" until older pages are
    // exhausted too. Page backward until it appears or nothing is left,
    // then (and only then) leave (#165). The page budget belongs to this
    // link target and starts over for another one; a failed page request
    // does not count against it — it is shown with a Retry instead.
    const target = deepLinkTarget(sessionId, messageId);
    const pagesRequested = React.useRef(0);
    const budgetTarget = React.useRef(target);
    if (budgetTarget.current !== target) {
        budgetTarget.current = target;
        pagesRequested.current = 0;
    }
    const [pagingError, setPagingError] = React.useState<string | null>(null);
    React.useEffect(() => { setPagingError(null); }, [target]);
    const retryPaging = React.useCallback(() => setPagingError(null), []);
    React.useEffect(() => {
        const step = deepLinkStep({
            messagesLoaded,
            found: !!message,
            hasMoreOlder,
            isLoadingOlder,
            pagesRequested: pagesRequested.current,
            pagingFailed: pagingError !== null,
        });
        if (step === 'loadOlder' && sessionId) {
            pagesRequested.current += 1;
            let cancelled = false;
            sync.loadOlderMessages(sessionId).catch((e) => {
                if (cancelled) return;
                pagesRequested.current -= 1; // a failed request is not a consumed page
                setPagingError(errorMessage(e));
            });
            return () => { cancelled = true; };
        } else if (step === 'back') {
            router.back();
        }
    }, [messagesLoaded, message, hasMoreOlder, isLoadingOlder, pagingError, sessionId, router]);
    
    // Configure header for tool messages
    React.useLayoutEffect(() => {
        if (message && message.kind === 'tool-call' && message.tool) {
            // Header is configured in the Stack.Screen options
        }
    }, [message]);
    
    // Show loader while waiting for session and messages to load
    if (!session || !messagesLoaded) {
        return (
            <View style={styles.loadingContainer}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
        );
    }
    
    // Loaded but not yet found: older pages are still being fetched (the
    // effect above pages until it appears or navigates back). A page that
    // failed to load is retryable, not a reason to leave.
    if (!message) {
        return (
            <View style={styles.loadingContainer}>
                {pagingError !== null ? (
                    <>
                        <Text style={styles.pagingError}>{t('errors.historyPageFailed')}</Text>
                        <Pressable onPress={retryPaging} hitSlop={10}>
                            <Text style={styles.retryText}>{t('common.retry')}</Text>
                        </Pressable>
                    </>
                ) : (
                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                )}
            </View>
        );
    }
    
    return (
        <>
            {message && message.kind === 'tool-call' && message.tool && (
                <Stack.Screen
                    options={{
                        headerTitle: () => <ToolHeader tool={message.tool} />,
                        headerRight: () => <ToolStatusIndicator tool={message.tool} />,
                        headerStyle: {
                            backgroundColor: theme.colors.header.background,
                        },
                        headerTintColor: theme.colors.header.tint,
                        headerShadowVisible: false,
                    }}
                />
            )}
            <Deferred>
                <FullView message={message} />
            </Deferred>
        </>
    );
});

function FullView(props: { message: Message }) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { id: sessionId } = useLocalSearchParams<{ id: string }>();

    if (props.message.kind === 'tool-call') {
        return <ToolFullView tool={props.message.tool} messages={props.message.children} sessionId={sessionId} />
    }
    if (props.message.kind === 'agent-text') {
        return (
            <View style={styles.fullViewContainer}>
                <Text style={styles.messageText}>{props.message.text}</Text>
            </View>
        )
    }
    if (props.message.kind === 'user-text') {
        return (
            <View style={styles.fullViewContainer}>
                <Text style={styles.messageText}>{props.message.text}</Text>
            </View>
        )
    }
    return null;
}