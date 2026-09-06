import { Platform, Alert } from 'react-native';
import { t } from '@/text';
import { AlertButton, ModalConfig, CustomModalConfig, IModal } from './types';
import { guarded, alertError } from '@/utils/guardAsync';

/** The provider-side renderer: the manager mints the id so a request made
 *  before the provider registered can still hand out its id synchronously
 *  and be replayed later (#335). */
export type ShowModalFn = (id: string, config: Omit<ModalConfig, 'id'>) => void;

class ModalManagerClass implements IModal {
    private showModalFn: ShowModalFn | null = null;
    private hideModalFn: ((id: string) => void) | null = null;
    private hideAllModalsFn: (() => void) | null = null;
    /** Identity of the provider whose functions are installed, so an OLD
     *  provider's unmount cleanup cannot tear down a NEWER provider's
     *  registration (#336). */
    private owner: object | null = null;
    /**
     * Requests made while no provider is registered. A descendant's mount
     * effect runs before the provider's own registration effect, so the first
     * dialogs of the app used to be logged as "not initialized" and resolved
     * as cancelled (#335); likewise a request made between one provider
     * unmounting and its replacement mounting was dispatched to a dead
     * setState (#336). They wait here and replay on the next registration.
     */
    private queued: Array<{ id: string; config: Omit<ModalConfig, 'id'> }> = [];
    private confirmResolvers: Map<string, (value: boolean) => void> = new Map();
    private promptResolvers: Map<string, (value: string | null) => void> = new Map();

    setFunctions(
        owner: object,
        showModal: ShowModalFn,
        hideModal: (id: string) => void,
        hideAllModals: () => void
    ) {
        this.owner = owner;
        this.showModalFn = showModal;
        this.hideModalFn = hideModal;
        this.hideAllModalsFn = hideAllModals;
        const queued = this.queued;
        this.queued = [];
        for (const { id, config } of queued) {
            showModal(id, config);
        }
    }

    /**
     * Provider unmount. Only the current owner may unregister (#336). Its
     * dialogs vanished with its React state, so their awaiting callers are
     * settled as cancelled — unless the SAME owner registers again in the
     * same tick: React StrictMode simulates an unmount/remount of one
     * provider instance (state kept), and cancelling there would answer
     * dialogs that are still on screen. A DIFFERENT provider registering in
     * that tick is a new instance with empty state: the old owner's dialogs
     * are gone from the screen and their callers must be settled, not left
     * with a resolver forever.
     */
    clearFunctions(owner: object) {
        if (this.owner !== owner) return;
        this.owner = null;
        this.showModalFn = null;
        this.hideModalFn = null;
        this.hideAllModalsFn = null;
        // Only the dialogs that were on screen are orphaned; a request made in
        // the gap before a replacement mounts is queued and must survive.
        const orphaned = [...this.confirmResolvers.keys(), ...this.promptResolvers.keys()];
        Promise.resolve().then(() => {
            if (this.owner === owner) return; // same instance replayed its effect
            for (const id of orphaned) this.cancelPending(id);
        });
    }

    private generateId(): string {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }

    /** Hand a config to the provider, or park it until one registers (#335/#336). */
    private dispatch(config: Omit<ModalConfig, 'id'>): string {
        const id = this.generateId();
        if (this.showModalFn) {
            this.showModalFn(id, config);
        } else {
            console.warn('ModalManager: no ModalProvider registered yet; the request is queued until one mounts.');
            this.queued.push({ id, config });
        }
        return id;
    }

    alert(title: string, message?: string, buttons?: AlertButton[]): void {
        if (Platform.OS === 'web') {
            this.dispatch({
                type: 'alert',
                title,
                message,
                buttons: buttons || [{ text: t('common.ok') }]
            } as Omit<ModalConfig, 'id'>);
        } else if (Platform.OS === 'android' && buttons && buttons.length > 3) {
            // Android's Alert keeps only three buttons and is not cancelable by
            // default: a 5-button sheet hid Draw and Cancel (#19). The custom
            // modal renders every button.
            this.dispatch({ type: 'alert', title, message, buttons } as Omit<ModalConfig, 'id'>);
        } else {
            // Use native alert. RN's Alert ignores a button's return value, so
            // an async onPress that rejected escaped unhandled; each handler
            // is wrapped so a failure is reported.
            const guardedButtons = buttons?.map((b) => b.onPress
                ? { ...b, onPress: guarded(b.onPress, alertError()) }
                : b);
            Alert.alert(title, message, guardedButtons, { cancelable: true });
        }
    }

    async confirm(
        title: string,
        message?: string,
        options?: {
            cancelText?: string;
            confirmText?: string;
            destructive?: boolean;
        }
    ): Promise<boolean> {
        if (Platform.OS === 'web') {
            const modalId = this.dispatch({
                type: 'confirm',
                title,
                message,
                cancelText: options?.cancelText,
                confirmText: options?.confirmText,
                destructive: options?.destructive
            } as Omit<ModalConfig, 'id'>);

            return new Promise<boolean>((resolve) => {
                this.confirmResolvers.set(modalId, resolve);
            });
        } else {
            // Use native alert
            return new Promise<boolean>((resolve) => {
                Alert.alert(
                    title,
                    message,
                    [
                        {
                            text: options?.cancelText || t('common.cancel'),
                            style: 'cancel',
                            onPress: () => resolve(false)
                        },
                        {
                            text: options?.confirmText || t('common.ok'),
                            style: options?.destructive ? 'destructive' : 'default',
                            onPress: () => resolve(true)
                        }
                    ],
                    { cancelable: false }
                );
            });
        }
    }

    show(config: Omit<CustomModalConfig, 'id' | 'type'>): string {
        return this.dispatch({
            ...config,
            type: 'custom'
        });
    }

    hide(id: string): void {
        // A dialog removed by id without an answer settles its caller (#334).
        this.cancelPending(id);
        if (this.hideModalFn) {
            this.hideModalFn(id);
        }
    }

    hideAll(): void {
        // Every removed confirm/prompt settles as cancelled instead of leaving
        // its awaiting caller hung with a retained resolver (#334).
        this.cancelAllPending();
        if (this.hideAllModalsFn) {
            this.hideAllModalsFn();
        }
    }

    resolveConfirm(id: string, value: boolean): void {
        const resolver = this.confirmResolvers.get(id);
        if (resolver) {
            resolver(value);
            this.confirmResolvers.delete(id);
        }
    }

    resolvePrompt(id: string, value: string | null): void {
        const resolver = this.promptResolvers.get(id);
        if (resolver) {
            resolver(value);
            this.promptResolvers.delete(id);
        }
    }

    /**
     * Settle a dialog that disappeared WITHOUT an answer — onRequestClose,
     * hide(id), hideAll, provider unmount (#100 #334 #336). A dialog that was
     * already answered has no resolver left, so its result is preserved.
     */
    cancelPending(id: string): void {
        this.queued = this.queued.filter((q) => q.id !== id);
        this.resolveConfirm(id, false);
        this.resolvePrompt(id, null);
    }

    cancelAllPending(): void {
        this.queued = [];
        for (const id of Array.from(this.confirmResolvers.keys())) this.resolveConfirm(id, false);
        for (const id of Array.from(this.promptResolvers.keys())) this.resolvePrompt(id, null);
    }

    /** Test/diagnostic hook: how many confirm/prompt callers are still waiting. */
    pendingCount(): number {
        return this.confirmResolvers.size + this.promptResolvers.size;
    }

    async prompt(
        title: string,
        message?: string,
        options?: {
            placeholder?: string;
            defaultValue?: string;
            cancelText?: string;
            confirmText?: string;
            inputType?: 'default' | 'secure-text' | 'email-address' | 'numeric';
        }
    ): Promise<string | null> {
        if (Platform.OS === 'ios' && !options?.inputType) {
            // Use native Alert.prompt on iOS (only supports basic text input)
            return new Promise<string | null>((resolve) => {
                // @ts-ignore - Alert.prompt is iOS only
                Alert.prompt(
                    title,
                    message,
                    [
                        {
                            text: options?.cancelText || t('common.cancel'),
                            style: 'cancel',
                            onPress: () => resolve(null)
                        },
                        {
                            text: options?.confirmText || t('common.ok'),
                            // null means CANCELLED, nothing else: an OK on an
                            // erased field must reach the caller as '' so
                            // "clear this limit" is possible (#176). The web
                            // prompt already resolves the raw input.
                            onPress: (text?: string) => resolve(typeof text === 'string' ? text : '')
                        }
                    ],
                    'plain-text',
                    options?.defaultValue,
                    'default'
                );
            });
        } else {
            // Use custom modal for web and Android
            const modalId = this.dispatch({
                type: 'prompt',
                title,
                message,
                placeholder: options?.placeholder,
                defaultValue: options?.defaultValue,
                cancelText: options?.cancelText,
                confirmText: options?.confirmText,
                inputType: options?.inputType
            } as Omit<ModalConfig, 'id'>);

            return new Promise<string | null>((resolve) => {
                this.promptResolvers.set(modalId, resolve);
            });
        }
    }
}

export const Modal = new ModalManagerClass();
