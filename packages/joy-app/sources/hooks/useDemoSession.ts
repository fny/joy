import { useEffect } from 'react';
import { storage } from '@/sync/storage';
import { createReducer } from '@/sync/reducer/reducer';
import { Message } from '@/sync/typesMessage';
import { DEMO_SESSION_ID, demoSessionStub } from '@/sync/demoSession';
import { debugMessages } from '@/app/(app)/dev/messages-demo-data';

// Loads the message-rendering demo fixtures (a stub session record + the demo
// messages) into storage when `active`, so the demo session's sub-routes — the
// message detail page, etc. — render fixture data even when reached directly
// (not just from the demo list page). Cleans up on unmount.
export function useDemoSession(active: boolean): string {
    useEffect(() => {
        if (!active) return;
        const messagesMap: Record<string, Message> = {};
        debugMessages.forEach((m) => { messagesMap[m.id] = m; });
        const sorted = [...debugMessages].sort((a, b) => b.createdAt - a.createdAt);
        storage.setState((state) => ({
            ...state,
            sessions: { ...state.sessions, [DEMO_SESSION_ID]: demoSessionStub() },
            sessionMessages: {
                ...state.sessionMessages,
                [DEMO_SESSION_ID]: {
                    messages: sorted,
                    messagesMap,
                    reducerState: createReducer(),
                    isLoaded: true,
                    hasMoreOlder: false,
                    isLoadingOlder: false,
                },
            },
        }));
        return () => {
            storage.setState((state) => {
                const { [DEMO_SESSION_ID]: _m, ...restMessages } = state.sessionMessages;
                const { [DEMO_SESSION_ID]: _s, ...restSessions } = state.sessions;
                return { ...state, sessions: restSessions, sessionMessages: restMessages };
            });
        };
    }, [active]);
    return DEMO_SESSION_ID;
}
