import type { Router } from "expo-router"
import { usePathname, useRouter } from "expo-router"

// Module-level mirror of the current pathname, written by <PathnameTracker/>
// in the root layout. Lets non-hook callers (notification-tap routing in
// _layout) know where the user currently is without threading a hook value
// through the notification pipeline.
export const currentPathname = { value: '/' };

export function PathnameTracker() {
    // Assigned during render on purpose: the mirror must be current before any
    // press/notification handler that fires after this navigation state commits.
    currentPathname.value = usePathname();
    return null;
}

export function navigateToSession(router: Router, sessionId: string) {
    // Session→session hops REPLACE instead of push. Pushing chained the chats
    // (A→B→C…), so the back button walked the chain instead of revealing the
    // sessions list — the classic mobile trap when hopping between sessions
    // via notifications or quick actions.
    if (currentPathname.value.startsWith('/session/')) {
        router.replace(`/session/${encodeURIComponent(sessionId)}`);
    } else {
        router.push(`/session/${encodeURIComponent(sessionId)}`);
    }
}

export function useNavigateToSession() {
    const router = useRouter();
    return (sessionId: string) => {
        navigateToSession(router, sessionId);
    }
}
