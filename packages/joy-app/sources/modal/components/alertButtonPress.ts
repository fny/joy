import { errorMessage, isThenable } from '@/utils/guardAsync';

/**
 * The web alert's button-press decision, pure so it can be tested (#331).
 *
 * A button's onPress may be sync or async. Sync: close on return, show the
 * error inline on throw. Async: the dialog stays open with its buttons
 * disabled until the promise settles — success closes it, a rejection is
 * shown inline and the buttons come back so the user can retry or cancel.
 * Before, the dialog closed immediately and the rejection escaped unhandled
 * with the retry control already gone.
 */
export interface AlertButtonHost {
    /** False once the dialog has unmounted; late failures are then dropped
     *  (nothing could display them). */
    isLive(): boolean;
    /** An async action started: disable buttons, clear a previous failure. */
    pending(): void;
    /** The action finished (or there was none): dismiss the dialog. */
    close(): void;
    /** The action failed: show the message and re-enable the buttons. */
    fail(message: string): void;
}

export function runAlertButton(onPress: (() => unknown) | undefined, host: AlertButtonHost): void {
    if (!onPress) {
        host.close();
        return;
    }
    let result: unknown;
    try {
        result = onPress();
    } catch (e) {
        host.fail(errorMessage(e));
        return;
    }
    if (!isThenable(result)) {
        host.close();
        return;
    }
    host.pending();
    Promise.resolve(result).then(
        () => host.close(),
        (e) => { if (host.isLive()) host.fail(errorMessage(e)); },
    );
}

export interface AlertButtonGate {
    /** True while a press is being handled (sync or awaiting an async action). */
    isBusy(): boolean;
    /** Run the press unless one is already in flight; returns whether it ran. */
    press(onPress: (() => unknown) | undefined, host: AlertButtonHost): boolean;
}

/**
 * A SYNCHRONOUS in-flight guard around runAlertButton. The dialog's React
 * `pending` state only lands after a commit, so two activations of the same
 * handler before that commit (a double-click, Enter plus click) launched the
 * async action twice (#331). The gate is claimed before onPress is called
 * and released only when the operation settles — close or fail.
 */
export function createAlertButtonGate(): AlertButtonGate {
    let busy = false;
    return {
        isBusy: () => busy,
        press(onPress, host) {
            if (busy) return false;
            busy = true;
            runAlertButton(onPress, {
                isLive: host.isLive,
                pending: host.pending,
                close: () => { busy = false; host.close(); },
                fail: (message) => { busy = false; host.fail(message); },
            });
            return true;
        },
    };
}
