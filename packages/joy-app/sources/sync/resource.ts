/**
 * Resource-owned queries (review campaign architecture item 7, Wave E4).
 *
 * A resource is a machine read the app caches: a file's contents, a project's
 * git status, a machine's session list, a picker catalog. The rules every
 * resource in this registry follows, and that its consumers used to each
 * re-implement with generation tokens (utils/latest) or private caches:
 *
 *  - KEYED BY THE REAL IDENTITY. The key carries machine, repo/session, path
 *    and options; a `version` (a revision the caller knows about) marks data
 *    stale without changing the key, so the last good value survives.
 *  - A REQUEST WRITES ONLY ITS RESOURCE CACHE. Never the component that
 *    happened to be mounted when it finished: results land under their key
 *    or not at all.
 *  - LATEST WINS PER KEY. Every request mints a generation; a completion
 *    publishes only while it is still the newest. A newer refresh, a
 *    mutation (`setData`) or `cancel` supersedes what is in flight. The
 *    AbortSignal handed to the fetcher is a courtesy for fetchers that can
 *    stop early — the generation check is what guarantees the drop, so a
 *    fetcher that ignores the signal still cannot land a stale write.
 *  - FOUR DISTINCT STATES. `data` (the last good value, kept across failures),
 *    `error` (the newest request ran and failed), `unavailable` (the newest
 *    request could not be made: no machine context, no live session) and an
 *    authoritative empty result (an `ok` outcome whose data IS the empty
 *    value — null, [] — which replaces the last good value like any other).
 *  - FOCUS, RECONNECT AND INVALIDATION ARE POLICIES. `invalidate` marks a key
 *    stale and refetches it when it is observed; app focus and relay
 *    reconnect refetch observed keys whose spec opted in.
 *  - UNSENT USER INTENT STAYS OUT. Drafts, edits, pending saves live in
 *    component/session state; `setData` is how a mutation's RESULT enters.
 *
 * Pure module: no React, no react-native, so the contract is unit-tested in
 * node. hooks/useResource.ts binds it to components.
 */
import equal from 'fast-deep-equal';

export type ResourceOutcome<T> =
    | { kind: 'ok'; data: T }
    /** The request could not be made (no context, no live session). The last
     *  good value stands and no error is shown; the next policy trigger retries. */
    | { kind: 'unavailable'; reason: string }
    /** The request ran and the resource's own authority refused (git failed,
     *  daemon 4xx). Not retried automatically; the last good value stands. */
    | { kind: 'error'; reason: string };

export interface ResourceSpec<T> {
    key: string;
    /** Throwing is a retryable error (bounded by `retry`). */
    fetch: (ctx: { signal: AbortSignal }) => Promise<ResourceOutcome<T>>;
    /** Revision the data must belong to. A different version than the one the
     *  data was fetched for makes the entry stale (refetched on ensure) while
     *  the last good value stays visible. */
    version?: string;
    /** How long a successful result counts as fresh for `ensure` (ms). Default
     *  0: every ensure revalidates (last good value shown meanwhile). */
    staleTime?: number;
    /** Equality that keeps the previous reference when a refetch returns the
     *  same value (so consumers keyed on identity do not re-run). Default:
     *  fast-deep-equal. */
    equal?: (a: T, b: T) => boolean;
    /** Bounded retry for THROWN fetch errors. */
    retry?: { attempts: number; delayMs: number };
    /** Refetch observed entries when the app regains focus / the relay reconnects. */
    refetchOnFocus?: boolean;
    refetchOnReconnect?: boolean;
    /** Eviction budget group (see `defineFamily`). */
    family?: string;
}

export interface ResourceEntry<T> {
    key: string;
    /** Last good value; `undefined` until the first ok outcome. */
    data: T | undefined;
    hasData: boolean;
    /** When `data` was last CHANGED (an equal refetch keeps the old stamp). */
    dataUpdatedAt: number;
    /** When the newest ok outcome landed, equal or not (freshness). */
    checkedAt: number;
    /** The `version` the data was fetched under. */
    dataVersion: string | undefined;
    fetching: boolean;
    /** The newest request failed (thrown or `error` outcome). Cleared by the next ok. */
    error: string | null;
    /** The newest request could not run. Cleared by the next ok or error. */
    unavailable: string | null;
    /** Explicitly invalidated since the last ok. */
    invalidated: boolean;
}

export interface EnsureOptions {
    /** Override the spec's staleTime for this call (Infinity: only when missing). */
    staleTime?: number;
}

export interface FamilyBudget {
    maxEntries?: number;
    maxBytes?: number;
    size?: (data: unknown) => number;
}

type Listener = () => void;

interface Internal<T> {
    entry: ResourceEntry<T>;
    spec: ResourceSpec<T> | null;
    gen: number;
    controller: AbortController | null;
    inFlight: Promise<ResourceEntry<T>> | null;
    observers: number;
    lastTouched: number;
}

const IDLE = <T>(key: string): ResourceEntry<T> => ({
    key, data: undefined, hasData: false, dataUpdatedAt: 0, checkedAt: 0, dataVersion: undefined,
    fetching: false, error: null, unavailable: null, invalidated: false,
});

export function errorText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/** Race a promise against `ms` and the resource's abort signal. */
export function withTimeout<T>(p: Promise<T>, ms: number, signal?: AbortSignal, label = 'timeout'): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(label)), ms);
        const onAbort = () => { clearTimeout(timer); reject(new Error('aborted')); };
        signal?.addEventListener('abort', onAbort, { once: true });
        p.then((v) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(v); },
            (e) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(e); });
    });
}

export class ResourceStore {
    private entries = new Map<string, Internal<unknown>>();
    private listeners = new Map<string, Set<Listener>>();
    private families = new Map<string, FamilyBudget>();
    private now: () => number;

    constructor(opts: { now?: () => number } = {}) {
        this.now = opts.now ?? (() => Date.now());
    }

    defineFamily(name: string, budget: FamilyBudget): void {
        this.families.set(name, budget);
    }

    /** The entry as it is now (an idle entry for an unknown key). */
    peek<T>(key: string): ResourceEntry<T> {
        return (this.entries.get(key)?.entry as ResourceEntry<T> | undefined) ?? this.idle<T>(key);
    }

    subscribe(key: string, listener: Listener): () => void {
        let set = this.listeners.get(key);
        if (!set) { set = new Set(); this.listeners.set(key, set); }
        set.add(listener);
        const internal = this.internal(key);
        internal.observers++;
        return () => {
            set!.delete(listener);
            if (set!.size === 0) this.listeners.delete(key);
            internal.observers = Math.max(0, internal.observers - 1);
        };
    }

    isObserved(key: string): boolean {
        return (this.entries.get(key)?.observers ?? 0) > 0;
    }

    /** Freshness under the spec's (or the override's) staleTime and version. */
    isStale<T>(spec: ResourceSpec<T>, opts: EnsureOptions = {}): boolean {
        const e = this.peek<T>(spec.key);
        if (!e.hasData || e.invalidated) return true;
        if (spec.version !== undefined && e.dataVersion !== spec.version) return true;
        const staleTime = opts.staleTime ?? spec.staleTime ?? 0;
        if (staleTime === Infinity) return false;
        return this.now() - e.checkedAt >= staleTime;
    }

    /**
     * Fetch unless the entry is fresh. Coalesces with a request already in
     * flight for the key (it will answer for this caller too). Resolves with
     * the entry once the read that answers it settled.
     */
    ensure<T>(spec: ResourceSpec<T>, opts: EnsureOptions = {}): Promise<ResourceEntry<T>> {
        const internal = this.internal<T>(spec.key);
        internal.spec = spec;
        internal.lastTouched = this.now();
        if (internal.inFlight) return internal.inFlight;
        if (!this.isStale(spec, opts)) return Promise.resolve(internal.entry);
        return this.run(internal, spec);
    }

    /** Always start a new request; whatever is in flight for the key is superseded. */
    refresh<T>(spec: ResourceSpec<T>): Promise<ResourceEntry<T>> {
        const internal = this.internal<T>(spec.key);
        internal.spec = spec;
        internal.lastTouched = this.now();
        return this.run(internal, spec);
    }

    /**
     * Mark stale. Observed keys refetch right away (with their last spec);
     * unobserved keys refetch on their next ensure. `prefix` form invalidates
     * every key under it.
     */
    invalidate(key: string, opts: { prefix?: boolean; refetch?: boolean } = {}): void {
        const targets = opts.prefix
            ? Array.from(this.entries.values()).filter((i) => i.entry.key.startsWith(key))
            : [this.entries.get(key)].filter((i): i is Internal<unknown> => !!i);
        for (const internal of targets) {
            this.publish(internal, { ...internal.entry, invalidated: true });
            const refetch = opts.refetch ?? internal.observers > 0;
            if (refetch && internal.spec && !internal.inFlight) void this.run(internal, internal.spec);
        }
    }

    /**
     * A mutation's result enters the cache. Unconditional and generation-
     * bumping: every read in flight for the key (a poll, a prefetch, a
     * background revalidation that started before the write landed) is
     * superseded, so a pre-write read can never overwrite what was just
     * written. `version` stamps the data's revision when the caller has one.
     */
    setData<T>(key: string, data: T, opts: { version?: string } = {}): void {
        const internal = this.internal<T>(key);
        this.supersede(internal);
        const now = this.now();
        const prev = internal.entry;
        const same = prev.hasData && this.eq(internal.spec, prev.data as T, data);
        this.publish(internal, {
            ...prev, data: same ? prev.data : data, hasData: true,
            dataUpdatedAt: same ? prev.dataUpdatedAt : now, checkedAt: now,
            dataVersion: opts.version ?? prev.dataVersion,
            fetching: false, error: null, unavailable: null, invalidated: false,
        });
        this.enforceBudget(internal.spec?.family);
    }

    /** Abort what is in flight; its completion publishes nothing. */
    cancel(key: string): void {
        const internal = this.entries.get(key);
        if (!internal) return;
        this.supersede(internal);
        if (internal.entry.fetching) this.publish(internal, { ...internal.entry, fetching: false });
    }

    /** Drop the key (or every key under `prefix`) entirely: in-flight requests
     *  are superseded and the last good value is gone. */
    remove(key: string, opts: { prefix?: boolean } = {}): void {
        const keys = opts.prefix
            ? Array.from(this.entries.keys()).filter((k) => k.startsWith(key))
            : [key];
        for (const k of keys) {
            const internal = this.entries.get(k);
            if (!internal) continue;
            this.supersede(internal);
            this.entries.delete(k);
            this.publish(internal, this.idle(k), { detached: true });
        }
    }

    /** App regained focus: refetch observed entries whose spec opted in. */
    onFocus(): void {
        this.refetchObserved((s) => s.refetchOnFocus === true);
    }

    /** Relay reconnected: refetch observed entries whose spec opted in. */
    onReconnect(): void {
        this.refetchObserved((s) => s.refetchOnReconnect === true);
    }

    /** Every key currently held (tests and diagnostics). */
    keys(): string[] {
        return Array.from(this.entries.keys());
    }

    // ── internals ──────────────────────────────────────────────────────────

    private idle<T>(key: string): ResourceEntry<T> {
        return IDLE<T>(key);
    }

    private internal<T>(key: string): Internal<T> {
        let i = this.entries.get(key) as Internal<T> | undefined;
        if (!i) {
            i = { entry: this.idle<T>(key), spec: null, gen: 0, controller: null, inFlight: null, observers: 0, lastTouched: this.now() };
            this.entries.set(key, i as Internal<unknown>);
        }
        return i;
    }

    private eq<T>(spec: ResourceSpec<T> | null, a: T, b: T): boolean {
        return (spec?.equal ?? equal)(a, b);
    }

    private supersede<T>(internal: Internal<T>): void {
        internal.gen++;
        internal.controller?.abort();
        internal.controller = null;
        internal.inFlight = null;
    }

    private publish<T>(internal: Internal<T>, next: ResourceEntry<T>, opts: { detached?: boolean } = {}): void {
        if (!opts.detached) internal.entry = next;
        const set = this.listeners.get(next.key);
        if (set) for (const l of Array.from(set)) l();
    }

    private refetchObserved(policy: (spec: ResourceSpec<unknown>) => boolean): void {
        for (const internal of this.entries.values()) {
            if (internal.observers === 0 || !internal.spec || internal.inFlight) continue;
            if (!policy(internal.spec)) continue;
            void this.run(internal, internal.spec);
        }
    }

    private run<T>(internal: Internal<T>, spec: ResourceSpec<T>): Promise<ResourceEntry<T>> {
        this.supersede(internal);
        const gen = internal.gen;
        const controller = new AbortController();
        internal.controller = controller;
        internal.spec = spec;
        this.publish(internal, { ...internal.entry, fetching: true });
        const current = () => internal.gen === gen;

        const promise = (async (): Promise<ResourceEntry<T>> => {
            let attempt = 0;
            let outcome: ResourceOutcome<T> | null = null;
            let thrown: unknown = null;
            for (;;) {
                try {
                    outcome = await spec.fetch({ signal: controller.signal });
                    break;
                } catch (e) {
                    thrown = e;
                    if (!current()) break;
                    const retry = spec.retry;
                    if (!retry || attempt >= retry.attempts) break;
                    attempt++;
                    await new Promise<void>((r) => setTimeout(r, retry.delayMs));
                    if (!current()) break;
                }
            }
            // Superseded (a newer request, a mutation, a cancel, a removal):
            // this completion owns nothing. The entry as it stands is the answer.
            if (!current()) return internal.entry;
            internal.controller = null;
            internal.inFlight = null;
            const now = this.now();
            const prev = internal.entry;
            if (!outcome) {
                this.publish(internal, { ...prev, fetching: false, error: errorText(thrown), unavailable: null });
            } else if (outcome.kind === 'ok') {
                const same = prev.hasData && this.eq(spec, prev.data as T, outcome.data);
                this.publish(internal, {
                    ...prev, data: same ? prev.data : outcome.data, hasData: true,
                    dataUpdatedAt: same ? prev.dataUpdatedAt : now, checkedAt: now, dataVersion: spec.version,
                    fetching: false, error: null, unavailable: null, invalidated: false,
                });
                this.enforceBudget(spec.family);
            } else if (outcome.kind === 'error') {
                this.publish(internal, { ...prev, fetching: false, error: outcome.reason, unavailable: null });
            } else {
                this.publish(internal, { ...prev, fetching: false, unavailable: outcome.reason });
            }
            return internal.entry;
        })();
        internal.inFlight = promise;
        return promise;
    }

    private enforceBudget(family: string | undefined): void {
        if (!family) return;
        const budget = this.families.get(family);
        if (!budget) return;
        const members = Array.from(this.entries.values())
            .filter((i) => i.spec?.family === family && i.entry.hasData);
        const size = budget.size ?? (() => 0);
        let total = members.reduce((n, i) => n + size(i.entry.data), 0);
        let count = members.length;
        const over = () => (budget.maxEntries !== undefined && count > budget.maxEntries)
            || (budget.maxBytes !== undefined && total > budget.maxBytes);
        if (!over()) return;
        // Evict least-recently-touched, unobserved entries first.
        members.sort((a, b) => a.lastTouched - b.lastTouched);
        for (const i of members) {
            if (!over()) break;
            if (i.observers > 0 || i.inFlight) continue;
            total -= size(i.entry.data);
            count--;
            this.entries.delete(i.entry.key);
        }
    }
}

/** The app-wide registry. Tests build their own `new ResourceStore()`. */
export const resources = new ResourceStore();
