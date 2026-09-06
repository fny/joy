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
 *  - A REQUIREMENT THAT ARRIVES DURING A READ IS NOT LOST. The read in flight
 *    answers for the requirement it started with. An ensure for a NEWER
 *    version, an `invalidate`, a focus/reconnect policy that lands while it
 *    runs is recorded beside it and served by exactly ONE trailing read once
 *    it settles (the newest requirement wins; the callers waiting on it share
 *    that read). A read clears `invalidated` only for invalidations that
 *    predate its start — one that arrived mid-read stays until the trailing
 *    read lands.
 *  - FOUR DISTINCT STATES. `data` (the last good value, kept across failures),
 *    `error` (the newest request ran and failed), `unavailable` (the newest
 *    request could not be made: no machine context, no live session) and an
 *    authoritative empty result (an `ok` outcome whose data IS the empty
 *    value — null, [] — which replaces the last good value like any other).
 *    `error` and `unavailable` describe the NEWEST request only: each clears
 *    the other, so `error ?? unavailable` is always the current state.
 *  - FOCUS, RECONNECT AND INVALIDATION ARE POLICIES. `invalidate` marks a key
 *    stale and refetches it when it is actively observed; app focus and relay
 *    reconnect refetch actively observed keys whose spec opted in; context
 *    readiness (`onContextReady`: machine keys hydrated) refetches every
 *    actively observed key whose newest outcome was `unavailable`. A PASSIVE
 *    observer (`subscribe(..., { passive: true })`: a disabled hook, a badge)
 *    keeps the entry alive and receives every change but never triggers a
 *    read.
 *  - OBSERVED KEYS HAVE A STABLE SNAPSHOT. While anyone subscribes to a key
 *    its entry object is the same reference until the store publishes a
 *    change (useSyncExternalStore depends on this). `remove` of an observed
 *    key resets it to an idle entry IN PLACE — subscriptions and observer
 *    counts survive, the next ensure/refresh recreates it under the same
 *    observers — and only an unobserved key leaves the map.
 *  - MEMORY IS BOUNDED PER FAMILY, AND RECLAIMED WHEN READERS LEAVE. A
 *    family budget (`defineFamily`) caps entries and bytes and can expire
 *    idle entries; every entry counts toward `maxEntries` (failed,
 *    unavailable and empty ones included), bytes count for entries with
 *    data. The budget is enforced after every write AND when the last
 *    observer of a key leaves. Observed and in-flight entries are exempt
 *    ONLY while observed/in flight: an oversized mounted entry (a huge diff on
 *    screen) stays for as long as it is mounted, however far over budget the
 *    family is, and is reclaimed on unmount. An idle entry nobody observes
 *    and that holds nothing (no spec, no data) is dropped on unsubscribe.
 *  - UNSENT USER INTENT STAYS OUT. Drafts, edits, pending saves live in
 *    component/session state; `setData` is how a mutation's RESULT enters.
 *  - MUTATION RESULTS ARE ORDERED. `beginMutation` hands a write a ticket;
 *    `setData` with that ticket publishes only while no later write of the
 *    key has committed — a delayed acknowledgement of an older write is
 *    dropped and the key revalidated from disk instead, so two panels
 *    saving the same file cannot regress the shared cache.
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
    /** Refetch actively observed entries when the app regains focus / the relay reconnects. */
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
    /** How many ok outcomes (fetched or written) have landed, equal or not:
     *  a MONOTONIC identity for "the answer I saw" — unlike `checkedAt`,
     *  two answers can never share it and a clock step cannot reorder it. */
    revision: number;
    /** The `version` the data was fetched under. */
    dataVersion: string | undefined;
    fetching: boolean;
    /** The newest request failed (thrown or `error` outcome). Cleared by the next ok or unavailable. */
    error: string | null;
    /** The newest request could not run. Cleared by the next ok or error. */
    unavailable: string | null;
    /** Explicitly invalidated since the last ok that started after the invalidation. */
    invalidated: boolean;
}

export interface EnsureOptions {
    /** Override the spec's staleTime for this call (Infinity: only when missing). */
    staleTime?: number;
}

export interface FamilyBudget {
    /** Every member counts: with data, failed, unavailable or empty. */
    maxEntries?: number;
    /** Sum of `size` over members with data. */
    maxBytes?: number;
    size?: (data: unknown) => number;
    /** An unobserved member not touched (ensured, refreshed, written) for this
     *  long is reclaimed at the next budget pass, budget or not. */
    maxAgeMs?: number;
}

export interface SubscribeOptions {
    /** Keep the entry alive and hear every change, but never trigger a read
     *  (invalidate / focus / reconnect policies ignore passive observers). */
    passive?: boolean;
}

type Listener = () => void;

interface Trailing<T> {
    spec: ResourceSpec<T>;
    promise: Promise<ResourceEntry<T>>;
    resolve: (entry: ResourceEntry<T> | Promise<ResourceEntry<T>>) => void;
}

interface Internal<T> {
    entry: ResourceEntry<T>;
    spec: ResourceSpec<T> | null;
    gen: number;
    controller: AbortController | null;
    inFlight: Promise<ResourceEntry<T>> | null;
    /** The spec the read in flight runs under (its version is what it will record). */
    inFlightSpec: ResourceSpec<T> | null;
    /** A requirement that arrived during the read in flight: served once it settles. */
    trailing: Trailing<T> | null;
    /** Bumped by every `invalidate`; a read captures it at start. */
    invalidationGen: number;
    /** The store's context generation when the newest `unavailable` landed. */
    unavailableAtContext: number;
    /** Mutation tickets: the newest handed out, and the newest whose result landed. */
    mutationIssued: number;
    mutationCommitted: number;
    /** Active observers: their presence makes policies (invalidate, focus, reconnect) refetch. */
    observers: number;
    /** Passive observers: keep the entry alive, never trigger a read. */
    passive: number;
    lastTouched: number;
}

const IDLE = <T>(key: string): ResourceEntry<T> => ({
    key, data: undefined, hasData: false, dataUpdatedAt: 0, checkedAt: 0, revision: 0, dataVersion: undefined,
    fetching: false, error: null, unavailable: null, invalidated: false,
});

/** Idle snapshots handed out for keys the store does not hold: bounded so a
 *  burst of peeks at unknown keys cannot grow without limit. */
const IDLE_CACHE_MAX = 512;

export function errorText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/** Race a promise against `ms` and the resource's abort signal. An already-
 *  aborted signal rejects at once; the abort listener never outlives the race. */
export function withTimeout<T>(p: Promise<T>, ms: number, signal?: AbortSignal, label = 'timeout'): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        if (signal?.aborted) { reject(new Error('aborted')); return; }
        let timer: ReturnType<typeof setTimeout> | null = null;
        const cleanup = () => {
            if (timer !== null) { clearTimeout(timer); timer = null; }
            signal?.removeEventListener('abort', onAbort);
        };
        const onAbort = () => { cleanup(); reject(new Error('aborted')); };
        timer = setTimeout(() => { cleanup(); reject(new Error(label)); }, ms);
        signal?.addEventListener('abort', onAbort);
        p.then((v) => { cleanup(); resolve(v); }, (e) => { cleanup(); reject(e); });
    });
}

export class ResourceStore {
    private entries = new Map<string, Internal<unknown>>();
    private listeners = new Map<string, Set<Listener>>();
    private families = new Map<string, FamilyBudget>();
    private idles = new Map<string, ResourceEntry<unknown>>();
    /** Bumped by `onContextReady`: an `unavailable` recorded under an older
     *  generation is stale (the context it lacked may exist now). */
    private contextGen = 0;
    private now: () => number;

    constructor(opts: { now?: () => number } = {}) {
        this.now = opts.now ?? (() => Date.now());
    }

    defineFamily(name: string, budget: FamilyBudget): void {
        this.families.set(name, budget);
    }

    /** The entry as it is now (a stable idle entry for an unknown key). */
    peek<T>(key: string): ResourceEntry<T> {
        const held = this.entries.get(key);
        if (held) return held.entry as ResourceEntry<T>;
        return this.idle<T>(key);
    }

    /**
     * Hear every change of the key. The entry exists (idle) from now on and is
     * exempt from eviction until the last observer leaves. Active observers
     * (default) make the policies refetch; passive ones only keep it alive.
     */
    subscribe(key: string, listener: Listener, opts: SubscribeOptions = {}): () => void {
        let set = this.listeners.get(key);
        if (!set) { set = new Set(); this.listeners.set(key, set); }
        set.add(listener);
        const internal = this.internal(key);
        const passive = opts.passive === true;
        if (passive) internal.passive++; else internal.observers++;
        let done = false;
        return () => {
            if (done) return;
            done = true;
            set!.delete(listener);
            if (set!.size === 0) this.listeners.delete(key);
            if (passive) internal.passive = Math.max(0, internal.passive - 1);
            else internal.observers = Math.max(0, internal.observers - 1);
            if (internal.observers + internal.passive === 0) this.reclaim(internal);
        };
    }

    /** Anyone (active or passive) subscribes to the key. */
    isObserved(key: string): boolean {
        const i = this.entries.get(key);
        return !!i && i.observers + i.passive > 0;
    }

    /** Freshness under the spec's (or the override's) staleTime and version. */
    isStale<T>(spec: ResourceSpec<T>, opts: EnsureOptions = {}): boolean {
        const e = this.peek<T>(spec.key);
        if (!e.hasData || e.invalidated) return true;
        if (spec.version !== undefined && e.dataVersion !== spec.version) return true;
        if (e.unavailable !== null && (this.entries.get(spec.key)?.unavailableAtContext ?? 0) < this.contextGen) return true;
        const staleTime = opts.staleTime ?? spec.staleTime ?? 0;
        if (staleTime === Infinity) return false;
        return this.now() - e.checkedAt >= staleTime;
    }

    /**
     * Fetch unless the entry is fresh. Coalesces with a request already in
     * flight for the key when that request answers this requirement (same
     * version); a NEWER version is queued as the one trailing read that
     * runs once the active read settles. Resolves with the entry once the
     * read that answers this caller settled.
     */
    ensure<T>(spec: ResourceSpec<T>, opts: EnsureOptions = {}): Promise<ResourceEntry<T>> {
        const internal = this.internal<T>(spec.key);
        internal.spec = spec;
        internal.lastTouched = this.now();
        if (internal.inFlight) {
            const wanted = spec.version;
            const running = internal.inFlightSpec?.version;
            if (wanted === undefined || wanted === running) return internal.inFlight;
            return this.queueTrailing(internal, spec);
        }
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
     * Mark stale. Actively observed keys refetch right away (with their last
     * spec) — or, while a read is active, once it settles; unobserved keys
     * refetch on their next ensure. `prefix` form invalidates every key
     * under it.
     */
    invalidate(key: string, opts: { prefix?: boolean; refetch?: boolean } = {}): void {
        const targets = opts.prefix
            ? Array.from(this.entries.values()).filter((i) => i.entry.key.startsWith(key))
            : [this.entries.get(key)].filter((i): i is Internal<unknown> => !!i);
        for (const internal of targets) {
            internal.invalidationGen++;
            this.publish(internal, { ...internal.entry, invalidated: true });
            const refetch = opts.refetch ?? internal.observers > 0;
            if (refetch && internal.spec) this.requestRead(internal, internal.spec);
        }
    }

    /**
     * A mutation is about to be sent: the ticket orders its result against
     * the other mutations of the key. Hand it to `setData` with the result.
     */
    beginMutation(key: string): number {
        const internal = this.internal(key);
        return ++internal.mutationIssued;
    }

    /**
     * A mutation's result enters the cache. Generation-bumping: every read
     * in flight for the key (a poll, a prefetch, a background revalidation
     * that started before the write landed) is superseded, so a pre-write
     * read can never overwrite what was just written. `version` stamps the
     * data's revision when the caller has one (a daemon content hash).
     *
     * Mutation results are fenced by `ticket` (from `beginMutation`): a
     * result whose ticket is older than the newest committed one is a
     * delayed acknowledgement of a write that later writes have already
     * replaced on disk — it is NOT published (returns false) and, when the
     * key has a spec, a revalidating read is started instead, so the cache
     * converges on what is on disk. A result whose `version` equals the
     * cached version is the same content (published as an equal refetch).
     * Without a ticket the write is unconditional.
     *
     * A requirement queued behind the superseded read is answered by the
     * written entry (its caller re-ensures if it still needs another version).
     */
    setData<T>(key: string, data: T, opts: { version?: string; ticket?: number } = {}): boolean {
        const internal = this.internal<T>(key);
        if (opts.ticket !== undefined) {
            const sameContent = opts.version !== undefined && internal.entry.hasData && internal.entry.dataVersion === opts.version;
            if (opts.ticket < internal.mutationCommitted && !sameContent) {
                if (internal.spec && !internal.inFlight) void this.run(internal, internal.spec);
                return false;
            }
            internal.mutationCommitted = Math.max(internal.mutationCommitted, opts.ticket);
        }
        const waiting = this.supersede(internal);
        internal.lastTouched = this.now();
        const now = this.now();
        const prev = internal.entry;
        const same = prev.hasData && this.eq(internal.spec, prev.data as T, data);
        this.publish(internal, {
            ...prev, data: same ? prev.data : data, hasData: true,
            dataUpdatedAt: same ? prev.dataUpdatedAt : now, checkedAt: now, revision: prev.revision + 1,
            dataVersion: opts.version ?? prev.dataVersion,
            fetching: false, error: null, unavailable: null, invalidated: false,
        });
        waiting?.resolve(internal.entry);
        this.enforceBudget(internal.spec?.family);
        return true;
    }

    /** Abort what is in flight (and drop what was queued behind it); its
     *  completion publishes nothing. */
    cancel(key: string): void {
        const internal = this.entries.get(key);
        if (!internal) return;
        const waiting = this.supersede(internal);
        if (internal.entry.fetching) this.publish(internal, { ...internal.entry, fetching: false });
        waiting?.resolve(internal.entry);
    }

    /**
     * Drop the key (or every key under `prefix`) entirely: in-flight requests
     * are superseded and the last good value is gone. An observed key is
     * reset to idle IN PLACE (its subscribers keep their subscription and see
     * the idle entry; the next ensure/refresh recreates it under them);
     * an unobserved key leaves the map.
     */
    remove(key: string, opts: { prefix?: boolean } = {}): void {
        const keys = opts.prefix
            ? Array.from(this.entries.keys()).filter((k) => k.startsWith(key))
            : [key];
        for (const k of keys) {
            const internal = this.entries.get(k);
            if (!internal) continue;
            const waiting = this.supersede(internal);
            internal.spec = null;
            internal.lastTouched = this.now();
            if (internal.observers + internal.passive > 0) {
                this.publish(internal, this.idle(k, { fresh: true }));
            } else {
                this.entries.delete(k);
                this.publish(internal, this.idle(k), { detached: true });
            }
            waiting?.resolve(internal.observers + internal.passive > 0 ? internal.entry : this.idle(k));
        }
    }

    /** App regained focus: refetch actively observed entries whose spec opted in. */
    onFocus(): void {
        this.refetchObserved((s) => s.refetchOnFocus === true);
    }

    /** Relay reconnected: refetch actively observed entries whose spec opted in. */
    onReconnect(): void {
        this.refetchObserved((s) => s.refetchOnReconnect === true);
    }

    /**
     * Context arrived (machine keys hydrated, the relay key derived): every
     * actively observed entry whose newest outcome was `unavailable` is read
     * again — once, whatever its focus/reconnect policy — and an unobserved
     * one is stale for its next ensure. An `unavailable` that lands after
     * this call waits for the next context change.
     */
    onContextReady(): void {
        this.contextGen++;
        for (const internal of this.entries.values()) {
            if (internal.entry.unavailable === null || internal.observers === 0 || !internal.spec) continue;
            this.requestRead(internal, internal.spec);
        }
    }

    /** Every key currently held (tests and diagnostics). */
    keys(): string[] {
        return Array.from(this.entries.keys());
    }

    // ── internals ──────────────────────────────────────────────────────────

    /** The idle entry for a key the store does not hold: one object per key
     *  (a bounded cache), so repeated peeks are referentially stable. `fresh`
     *  mints a new one (a removal must publish a CHANGE to subscribers). */
    private idle<T>(key: string, opts: { fresh?: boolean } = {}): ResourceEntry<T> {
        if (opts.fresh) return IDLE<T>(key);
        let e = this.idles.get(key);
        if (!e) {
            if (this.idles.size >= IDLE_CACHE_MAX) this.idles.clear();
            e = IDLE<T>(key);
            this.idles.set(key, e);
        }
        return e as ResourceEntry<T>;
    }

    private internal<T>(key: string): Internal<T> {
        let i = this.entries.get(key) as Internal<T> | undefined;
        if (!i) {
            // Adopt the idle snapshot already handed out for this key so a
            // subscriber that peeked before subscribing sees no change.
            const entry = this.idle<T>(key);
            this.idles.delete(key);
            i = {
                entry, spec: null, gen: 0, controller: null, inFlight: null, inFlightSpec: null, trailing: null,
                invalidationGen: 0, unavailableAtContext: 0, mutationIssued: 0, mutationCommitted: 0,
                observers: 0, passive: 0, lastTouched: this.now(),
            };
            this.entries.set(key, i as Internal<unknown>);
        }
        return i;
    }

    private eq<T>(spec: ResourceSpec<T> | null, a: T, b: T): boolean {
        return (spec?.equal ?? equal)(a, b);
    }

    /** Orphan the read in flight; returns the requirement queued behind it
     *  (the caller decides what answers it). */
    private supersede<T>(internal: Internal<T>): Trailing<T> | null {
        internal.gen++;
        internal.controller?.abort();
        internal.controller = null;
        internal.inFlight = null;
        internal.inFlightSpec = null;
        const waiting = internal.trailing;
        internal.trailing = null;
        return waiting;
    }

    private publish<T>(internal: Internal<T>, next: ResourceEntry<T>, opts: { detached?: boolean } = {}): void {
        if (!opts.detached) internal.entry = next;
        const set = this.listeners.get(next.key);
        if (set) for (const l of Array.from(set)) l();
    }

    /** A policy wants a read: now, or — while one is active — once it settles. */
    private requestRead<T>(internal: Internal<T>, spec: ResourceSpec<T>): void {
        if (internal.inFlight) void this.queueTrailing(internal, spec);
        else void this.run(internal, spec);
    }

    /** Exactly one trailing read per active read: the newest requirement
     *  replaces the spec, every caller shares the promise. */
    private queueTrailing<T>(internal: Internal<T>, spec: ResourceSpec<T>): Promise<ResourceEntry<T>> {
        if (internal.trailing) {
            internal.trailing.spec = spec;
            return internal.trailing.promise;
        }
        let resolve!: Trailing<T>['resolve'];
        const promise = new Promise<ResourceEntry<T>>((r) => { resolve = r; });
        internal.trailing = { spec, promise, resolve };
        return promise;
    }

    private refetchObserved(policy: (spec: ResourceSpec<unknown>) => boolean): void {
        for (const internal of this.entries.values()) {
            if (internal.observers === 0 || !internal.spec) continue;
            if (!policy(internal.spec)) continue;
            this.requestRead(internal, internal.spec);
        }
    }

    private run<T>(internal: Internal<T>, spec: ResourceSpec<T>): Promise<ResourceEntry<T>> {
        const waiting = this.supersede(internal);
        const gen = internal.gen;
        const startedAfterInvalidation = internal.invalidationGen;
        const controller = new AbortController();
        internal.controller = controller;
        internal.spec = spec;
        internal.inFlightSpec = spec;
        this.publish(internal, { ...internal.entry, fetching: true });
        const current = () => internal.gen === gen;

        // The in-flight record is installed BEFORE the fetcher runs, so a
        // fetcher that throws synchronously settles (and clears) it like any
        // other failure instead of leaving a settled promise behind.
        let settle!: (entry: ResourceEntry<T>) => void;
        const promise = new Promise<ResourceEntry<T>>((r) => { settle = r; });
        internal.inFlight = promise;
        // A requirement queued behind the read we just superseded is answered
        // by this newer read.
        waiting?.resolve(promise);

        const body = async (): Promise<ResourceEntry<T>> => {
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
            internal.inFlightSpec = null;
            const now = this.now();
            const prev = internal.entry;
            // An invalidation that arrived during this read is not satisfied by it.
            const invalidated = internal.invalidationGen !== startedAfterInvalidation;
            if (!outcome) {
                this.publish(internal, { ...prev, fetching: false, error: errorText(thrown), unavailable: null });
            } else if (outcome.kind === 'ok') {
                const same = prev.hasData && this.eq(spec, prev.data as T, outcome.data);
                this.publish(internal, {
                    ...prev, data: same ? prev.data : outcome.data, hasData: true,
                    dataUpdatedAt: same ? prev.dataUpdatedAt : now, checkedAt: now, revision: prev.revision + 1,
                    dataVersion: spec.version,
                    fetching: false, error: null, unavailable: null, invalidated,
                });
            } else if (outcome.kind === 'error') {
                this.publish(internal, { ...prev, fetching: false, error: outcome.reason, unavailable: null });
            } else {
                internal.unavailableAtContext = this.contextGen;
                this.publish(internal, { ...prev, fetching: false, error: null, unavailable: outcome.reason });
            }
            const answer = internal.entry;
            // The requirement that arrived while we ran: exactly one trailing read.
            const trailing = internal.trailing;
            internal.trailing = null;
            if (trailing) trailing.resolve(this.run(internal, trailing.spec));
            else this.enforceBudget(spec.family);
            return answer;
        };
        body().then(settle, () => settle(internal.entry));
        return promise;
    }

    /** The last observer left: the entry is fair game for its family budget,
     *  and an idle entry holding nothing is dropped outright. */
    private reclaim<T>(internal: Internal<T>): void {
        if (internal.inFlight) return;
        if (!internal.spec && !internal.entry.hasData) {
            this.entries.delete(internal.entry.key);
            return;
        }
        this.enforceBudget(internal.spec?.family);
    }

    private enforceBudget(family: string | undefined): void {
        if (!family) return;
        const budget = this.families.get(family);
        if (!budget) return;
        const members = Array.from(this.entries.values()).filter((i) => i.spec?.family === family);
        const size = budget.size ?? (() => 0);
        const bytesOf = (i: Internal<unknown>) => (i.entry.hasData ? size(i.entry.data) : 0);
        const evictable = (i: Internal<unknown>) => i.observers + i.passive === 0 && !i.inFlight;
        let total = members.reduce((n, i) => n + bytesOf(i), 0);
        let count = members.length;
        const drop = (i: Internal<unknown>) => {
            total -= bytesOf(i);
            count--;
            this.entries.delete(i.entry.key);
        };
        // Expiry first: an unobserved member idle past maxAgeMs goes regardless of the caps.
        if (budget.maxAgeMs !== undefined) {
            const cutoff = this.now() - budget.maxAgeMs;
            for (const i of members) if (evictable(i) && i.lastTouched < cutoff) drop(i);
        }
        const over = () => (budget.maxEntries !== undefined && count > budget.maxEntries)
            || (budget.maxBytes !== undefined && total > budget.maxBytes);
        if (!over()) return;
        // Evict least-recently-touched, unobserved entries first.
        const candidates = members.filter((i) => this.entries.has(i.entry.key) && evictable(i))
            .sort((a, b) => a.lastTouched - b.lastTouched);
        for (const i of candidates) {
            if (!over()) break;
            drop(i);
        }
    }
}

/** The app-wide registry. Tests build their own `new ResourceStore()`. */
export const resources = new ResourceStore();
