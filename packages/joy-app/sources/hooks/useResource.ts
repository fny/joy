/**
 * Component binding for sync/resource: subscribe to a resource's entry,
 * ensure it on mount / key change / version change, and apply the focus,
 * polling and reconnect policies. The store owns the data; the component
 * owns nothing but its subscription.
 */
import * as React from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { resources, type ResourceEntry, type ResourceSpec } from '@/sync/resource';
import { storage } from '@/sync/storage';
import { useActiveInterval } from './useActiveInterval';

let signalsInstalled = false;
/** App focus → refetch observed entries that opted in; relay reconnect → same. */
function installResourceSignals(): void {
    if (signalsInstalled) return;
    signalsInstalled = true;
    try {
        AppState.addEventListener('change', (s) => { if (s === 'active') resources.onFocus(); });
        let last = storage.getState().socketStatus;
        storage.subscribe((state) => {
            const next = state.socketStatus;
            if (next === 'connected' && last !== 'connected') resources.onReconnect();
            last = next;
        });
    } catch {
        // Test environments without react-native: policies are exercised on the store directly.
    }
}

export interface UseResourceOptions {
    /** False: subscribe PASSIVELY — the entry stays alive and its changes are
     *  seen, but nothing fetches it on this hook's account (mount, screen
     *  focus, polling, app focus, reconnect, invalidate): a picker that is
     *  closed, an offline machine. */
    enabled?: boolean;
    /** Poll while the screen is focused and the app is foregrounded. */
    refetchInterval?: number;
    /** Screen focus (navigation): 'stale' re-ensures under staleTime, 'always'
     *  refreshes, false does nothing. Default 'stale'. */
    refetchOnScreenFocus?: 'stale' | 'always' | false;
}

export type ResourceView<T> = ResourceEntry<T> & {
    /** No value yet and a request is running (the only time a spinner is right). */
    isLoading: boolean;
    /** Start a new request now (supersedes what is in flight). */
    refresh: () => Promise<ResourceEntry<T>>;
};

/** The idle entry for "no key yet" (stable: peek caches idle snapshots per key). */
function idleFor<T>(): ResourceEntry<T> {
    return resources.peek<T>('');
}

/**
 * Ensure `spec` and, once the read that answered it settled, repair a
 * requirement the settlement did not meet: the entry holds data under
 * another version than the one this consumer asked for (the read was
 * superseded by a write or a cancel) — one more ensure, while the consumer
 * still wants that key. A failed or unavailable read is NOT retried here
 * (the store's own policies decide that), so this cannot loop on an error.
 */
function ensureAndRepair<T>(spec: ResourceSpec<T>, wanted: () => ResourceSpec<T> | null): void {
    void resources.ensure(spec).then(() => {
        const s = wanted();
        if (!s || s.key !== spec.key || s.version === undefined) return;
        const e = resources.peek<T>(s.key);
        if (e.fetching || e.error !== null || e.unavailable !== null || !e.hasData) return;
        if (e.dataVersion !== s.version) void resources.ensure(s);
    });
}

/**
 * Passive subscription: the entry as cached, never fetched by this hook and
 * with no navigation-focus binding (safe anywhere, e.g. list rows and badges).
 */
export function useResourceEntry<T>(key: string | null): ResourceEntry<T> {
    const subscribe = React.useCallback((listener: () => void) => (key ? resources.subscribe(key, listener) : () => {}), [key]);
    const getSnapshot = React.useCallback((): ResourceEntry<T> => (key ? resources.peek<T>(key) : idleFor<T>()), [key]);
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Subscribe to `spec.key` and keep it fresh. Passing `null` renders the idle
 * entry (no key yet — a session still hydrating). The returned entry object is
 * referentially stable until the store publishes a change for the key.
 */
export function useResource<T>(spec: ResourceSpec<T> | null, opts: UseResourceOptions = {}): ResourceView<T> {
    installResourceSignals();
    const enabled = opts.enabled ?? true;
    const key = spec?.key ?? null;
    const version = spec?.version;
    const specRef = React.useRef(spec);
    specRef.current = spec;

    // Disabled: a passive observer — the entry is kept alive for this
    // consumer, but no policy (focus, reconnect, invalidate) fetches on its
    // behalf.
    const subscribe = React.useCallback(
        (listener: () => void) => (key ? resources.subscribe(key, listener, { passive: !enabled }) : () => {}),
        [key, enabled],
    );
    const getSnapshot = React.useCallback((): ResourceEntry<T> => (key ? resources.peek<T>(key) : idleFor<T>()), [key]);
    const entry = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    React.useEffect(() => {
        if (!enabled || !specRef.current) return;
        let live = true;
        ensureAndRepair(specRef.current, () => (live ? specRef.current : null));
        return () => { live = false; };
    }, [key, version, enabled]);

    const onScreenFocus = opts.refetchOnScreenFocus ?? 'stale';
    const focusedKey = React.useRef<string | null | undefined>(undefined);
    useFocusEffect(React.useCallback(() => {
        // The ensure effect above already ran for this key; act on RE-focus only.
        if (focusedKey.current !== key) { focusedKey.current = key; return; }
        if (!enabled || !specRef.current || onScreenFocus === false) return;
        if (onScreenFocus === 'always') void resources.refresh(specRef.current);
        else void resources.ensure(specRef.current);
    }, [key, enabled, onScreenFocus]));

    // Polling coalesces with a read already in flight (ensure), so the tick
    // that fires on (re)start never doubles the mount read.
    const interval = opts.refetchInterval ?? 0;
    useActiveInterval(() => {
        if (specRef.current) void resources.ensure(specRef.current, { staleTime: 0 });
    }, interval, enabled && interval > 0 && !!key);

    const refresh = React.useCallback(() => {
        const s = specRef.current;
        return s ? resources.refresh(s) : Promise.resolve(idleFor<T>());
    }, []);

    return React.useMemo(() => ({
        ...entry,
        isLoading: !entry.hasData && entry.fetching,
        refresh,
    }), [entry, refresh]);
}

/**
 * Subscribe to many specs at once (a diff per changed file). Ensures each
 * whose key or version changed — a version that changes while its read is
 * still active is served by the store's trailing read, and repaired here
 * after settlement if that read was superseded; the returned array is
 * stable while no entry changed.
 */
export function useResources<T>(specs: ResourceSpec<T>[], opts: { enabled?: boolean } = {}): ResourceEntry<T>[] {
    installResourceSignals();
    const enabled = opts.enabled ?? true;
    const keys = specs.map((s) => s.key);
    const keysId = keys.join('\u0000');
    const versionsId = specs.map((s) => s.version ?? '').join('\u0000');
    const specsRef = React.useRef(specs);
    specsRef.current = specs;

    const subscribe = React.useCallback((listener: () => void) => {
        const unsubs = keys.map((k) => resources.subscribe(k, listener, { passive: !enabled }));
        return () => { for (const u of unsubs) u(); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [keysId, enabled]);
    const last = React.useRef<ResourceEntry<T>[]>([]);
    const getSnapshot = React.useCallback((): ResourceEntry<T>[] => {
        const next = keys.map((k) => resources.peek<T>(k));
        const prev = last.current;
        if (prev.length === next.length && prev.every((e, i) => e === next[i])) return prev;
        last.current = next;
        return next;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [keysId]);
    const entries = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    React.useEffect(() => {
        if (!enabled) return;
        let live = true;
        for (const s of specsRef.current) {
            ensureAndRepair(s, () => (live ? specsRef.current.find((c) => c.key === s.key) ?? null : null));
        }
        return () => { live = false; };
    }, [keysId, versionsId, enabled]);

    return entries;
}
