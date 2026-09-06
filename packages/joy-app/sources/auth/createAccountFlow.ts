import { createInFlightGuard } from '@/utils/inFlightGuard';

/**
 * "Create account" must run at most once at a time for the whole app. The
 * welcome screen's only guard used to be RoundButton's own loading state,
 * and a rotation/resize swaps the portrait and landscape trees, remounting
 * the button mid-request: a second press minted a second secret, and
 * whichever request finished last overwrote the credentials of the account
 * the sync engine had already booted with (#149). The guard is claimed
 * synchronously and held through login, so a second attempt is refused
 * rather than raced, and there is no "late completion" to fence.
 */
export interface CreateAccountDeps {
    randomBytes: (length: number) => Promise<Uint8Array>;
    getToken: (secret: Uint8Array) => Promise<string | null | undefined>;
    login: (token: string, secret: Uint8Array) => Promise<void>;
}

const guard = createInFlightGuard();

export type CreateAccountResult = 'created' | 'busy' | 'no_token';

export async function createAccountOnce(deps: CreateAccountDeps): Promise<CreateAccountResult> {
    const result = await guard.run(async (): Promise<CreateAccountResult> => {
        const secret = await deps.randomBytes(32);
        const token = await deps.getToken(secret);
        if (!token) return 'no_token';
        await deps.login(token, secret);
        return 'created';
    });
    return result ?? 'busy';
}

/** True while an account creation is in flight (drives the button spinner
 *  across remounts). */
export function isCreatingAccount(): boolean {
    return guard.busy;
}
