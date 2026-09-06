import React, { createContext, useContext, useState, useLayoutEffect, useCallback, useRef } from 'react';
import { ModalState, ModalConfig, ModalContextValue } from './types';
import { Modal } from './ModalManager';
import { WebAlertModal } from './components/WebAlertModal';
import { WebPromptModal } from './components/WebPromptModal';
import { CustomModal } from './components/CustomModal';

const ModalContext = createContext<ModalContextValue | undefined>(undefined);

export function useModal() {
    const context = useContext(ModalContext);
    if (!context) {
        throw new Error('useModal must be used within a ModalProvider');
    }
    return context;
}

export function ModalProvider({ children }: { children: React.ReactNode }) {
    const [state, setState] = useState<ModalState>({
        modals: []
    });
    // Ownership token handed to the manager: only THIS instance's cleanup may
    // unregister, so an unmounting provider cannot pull the rug from under a
    // replacement that registered after it (#336).
    const ownerRef = useRef<object | null>(null);
    if (ownerRef.current === null) ownerRef.current = {};

    const generateId = useCallback(() => {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }, []);

    const showModalWithId = useCallback((id: string, config: Omit<ModalConfig, 'id'>) => {
        const modalConfig: ModalConfig = { ...config, id } as ModalConfig;
        setState(prev => ({
            modals: [...prev.modals, modalConfig]
        }));
    }, []);

    const showModal = useCallback((config: Omit<ModalConfig, 'id'>): string => {
        const id = generateId();
        showModalWithId(id, config);
        return id;
    }, [generateId, showModalWithId]);

    // Every removal path settles the dialog's promise. Before, a confirm
    // closed via onRequestClose (Escape keyup on web) and a prompt removed by
    // hide(id)/hideAll disappeared with their resolver still registered, so
    // the awaiting caller hung — useJoyAction's loading flag stayed true and
    // Delete was dead until reload (#100, #334). An already-answered dialog
    // has no resolver left, so its result is untouched.
    const hideModal = useCallback((id: string) => {
        Modal.cancelPending(id);
        setState(prev => ({
            modals: prev.modals.filter(modal => modal.id !== id)
        }));
    }, []);

    const hideAllModals = useCallback(() => {
        Modal.cancelAllPending();
        setState({ modals: [] });
    }, []);

    const dismissModal = useCallback((modal: ModalConfig) => {
        if (modal.type === 'confirm') {
            Modal.resolveConfirm(modal.id, false);
        } else if (modal.type === 'prompt') {
            Modal.resolvePrompt(modal.id, null);
        }
        hideModal(modal.id);
    }, [hideModal]);

    const dismissTopModal = useCallback(() => {
        const currentModal = state.modals[state.modals.length - 1];
        if (!currentModal) {
            return false;
        }
        dismissModal(currentModal);
        return true;
    }, [dismissModal, state.modals]);

    // Register with the manager in a LAYOUT effect: a descendant's passive
    // mount effect (a startup alert, a confirm on first render) runs after
    // every layout effect, so it finds the provider already installed instead
    // of being dropped as "not initialized" (#335). Anything requested even
    // earlier is queued by the manager and replayed here. The cleanup
    // unregisters with an ownership check (#336).
    useLayoutEffect(() => {
        const owner = ownerRef.current!;
        Modal.setFunctions(owner, showModalWithId, hideModal, hideAllModals);
        return () => Modal.clearFunctions(owner);
    }, [showModalWithId, hideModal, hideAllModals]);

    const contextValue: ModalContextValue = {
        state,
        showModal,
        hideModal,
        hideAllModals,
        dismissTopModal
    };

    // EVERY modal in the stack stays mounted, not just the top one. Rendering
    // only the top modal unmounted the prompt underneath whenever an alert
    // (e.g. a connection failure) appeared on top, so its typed draft was
    // gone when the alert closed (#333). Each entry is keyed by its modal id
    // so React never hands one prompt's input state to the next (#332).
    // Only the TOP dialog is visible and interactive; the ones beneath keep
    // their state but are hidden until they are on top again.
    const renderModal = (modal: ModalConfig, index: number) => {
        const active = index === state.modals.length - 1;
        switch (modal.type) {
            case 'alert':
                return (
                    <WebAlertModal
                        key={modal.id}
                        config={modal}
                        active={active}
                        onClose={() => hideModal(modal.id)}
                    />
                );
            case 'confirm':
                return (
                    <WebAlertModal
                        key={modal.id}
                        config={modal}
                        active={active}
                        onClose={() => dismissModal(modal)}
                        onConfirm={(value) => {
                            Modal.resolveConfirm(modal.id, value);
                            hideModal(modal.id);
                        }}
                    />
                );
            case 'prompt':
                return (
                    <WebPromptModal
                        key={modal.id}
                        config={modal}
                        active={active}
                        onClose={() => dismissModal(modal)}
                        onConfirm={(value) => {
                            Modal.resolvePrompt(modal.id, value);
                            hideModal(modal.id);
                        }}
                    />
                );
            case 'custom':
                return (
                    <CustomModal
                        key={modal.id}
                        config={modal}
                        onClose={() => hideModal(modal.id)}
                    />
                );
            default:
                return null;
        }
    };

    return (
        <ModalContext.Provider value={contextValue}>
            {children}
            {state.modals.map(renderModal)}
        </ModalContext.Provider>
    );
}
