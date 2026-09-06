/**
 * The device-side bookkeeping for ONE push registration on the relay, kept
 * pure so it can be tested without Expo:
 *
 *  - `reconcileRegistration` registers the current Expo token and retires the
 *    previous one. The retirement is PERSISTED as pending before it is
 *    attempted, and resumed on the next sync: replacing A with B and dying
 *    between "B saved" and "A unregistered" used to leave A registered forever,
 *    because the next sync saw B as both previous and current (#385).
 *  - `unregisterDevice` removes this device's token when Mobile push is turned
 *    off; the relay never sees the (device-local) setting, so the token has to
 *    be deleted explicitly, and a failed deletion stays pending for a retry (#181).
 *  - `serialized` runs every sync/unregister one at a time: two overlapping
 *    syncs across an Expo token rotation let the older one save its stale
 *    token and unregister the newer one (#386).
 */

export interface PushTokenStore {
    loadRegistered(): string | null;
    saveRegistered(token: string): void;
    clearRegistered(): void;
    /** Tokens the relay still holds that this device no longer uses. */
    loadPendingUnregister(): string[];
    savePendingUnregister(tokens: string[]): void;
}

export interface PushTokenApi {
    register(token: string): Promise<void>;
    unregister(token: string): Promise<void>;
}

export interface ReconcileResult {
    /** Old tokens whose deletion failed this time; retried on the next sync. */
    pending: string[];
}

export interface UnregisterDeviceResult {
    /** True when nothing of this device is left on the relay. */
    removed: boolean;
    pending: string[];
}

let chain: Promise<unknown> = Promise.resolve();

/** Run `op` after every previously scheduled push-token operation (#386). */
export function serialized<T>(op: () => Promise<T>): Promise<T> {
    const run = chain.then(op, op);
    chain = run.then(() => undefined, () => undefined);
    return run;
}

function unique(tokens: (string | null | undefined)[]): string[] {
    const out: string[] = [];
    for (const t of tokens) {
        if (t && !out.includes(t)) out.push(t);
    }
    return out;
}

/** Try to delete every token in `tokens`; returns the ones still on the relay. */
async function unregisterAll(api: PushTokenApi, tokens: string[], log: (m: string, e?: unknown) => void): Promise<string[]> {
    const remaining: string[] = [];
    for (const token of tokens) {
        try {
            await api.unregister(token);
        } catch (e) {
            log(`push token cleanup failed for ${token}`, e);
            remaining.push(token);
        }
    }
    return remaining;
}

export async function reconcileRegistration(
    api: PushTokenApi,
    store: PushTokenStore,
    currentToken: string,
    log: (m: string, e?: unknown) => void = () => {},
): Promise<ReconcileResult> {
    const previous = store.loadRegistered();
    await api.register(currentToken);

    // Persist the retirement of the old token BEFORE saving the new one, so a
    // crash between the two never loses track of it (#385).
    const retire = unique([...store.loadPendingUnregister(), previous]).filter((t) => t !== currentToken);
    store.savePendingUnregister(retire);
    store.saveRegistered(currentToken);

    const pending = await unregisterAll(api, retire, log);
    store.savePendingUnregister(pending);
    return { pending };
}

/** Retry the deletions a previous sync could not finish. */
export async function flushPendingUnregister(
    api: PushTokenApi,
    store: PushTokenStore,
    log: (m: string, e?: unknown) => void = () => {},
): Promise<string[]> {
    const current = store.loadRegistered();
    const retire = store.loadPendingUnregister().filter((t) => t !== current);
    const pending = await unregisterAll(api, retire, log);
    store.savePendingUnregister(pending);
    return pending;
}

export async function unregisterDevice(
    api: PushTokenApi,
    store: PushTokenStore,
    log: (m: string, e?: unknown) => void = () => {},
): Promise<UnregisterDeviceResult> {
    const registered = store.loadRegistered();
    const targets = unique([...store.loadPendingUnregister(), registered]);
    // Everything this device ever registered is now "to be removed" — persist
    // that first so a crash mid-way resumes the removal (#181).
    store.savePendingUnregister(targets);
    const pending = await unregisterAll(api, targets, log);
    store.savePendingUnregister(pending);
    if (registered && !pending.includes(registered)) {
        store.clearRegistered();
    }
    return { removed: pending.length === 0, pending };
}

/** True while the relay may still hold a token this device should not have. */
export function hasPendingCleanup(store: PushTokenStore): boolean {
    return store.loadPendingUnregister().length > 0;
}
