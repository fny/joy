import { useEffect } from 'react';
import { storage } from '@/sync/storage';
import { createReducer } from '@/sync/reducer/reducer';
import { Message } from '@/sync/typesMessage';
import { DEMO_SESSION_ID, demoSessionStub } from '@/sync/demoSession';
import { debugMessages } from '@/app/(app)/dev/messages-demo-data';
import { createSharedLease } from './sharedLease';

function installDemoFixtures() {
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
}

function removeDemoFixtures() {
    storage.setState((state) => {
        const { [DEMO_SESSION_ID]: _m, ...restMessages } = state.sessionMessages;
        const { [DEMO_SESSION_ID]: _s, ...restSessions } = state.sessions;
        return { ...state, sessions: restSessions, sessionMessages: restMessages };
    });
}

// The fixtures are shared by every mounted consumer (list + detail view), so
// they are reference-counted: the first active consumer installs them, the
// last one to leave removes them. Unmounting a detail view used to delete the
// session the still-mounted list was rendering (#314).
const demoLease = createSharedLease(installDemoFixtures, removeDemoFixtures);

// Loads the message-rendering demo fixtures (a stub session record + the demo
// messages) into storage when `active`, so the demo session's sub-routes — the
// message detail page, etc. — render fixture data even when reached directly
// (not just from the demo list page). Releases its hold on unmount.
export function useDemoSession(active: boolean): string {
    useEffect(() => {
        if (!active) return;
        return demoLease.acquire();
    }, [active]);
    return DEMO_SESSION_ID;
}
