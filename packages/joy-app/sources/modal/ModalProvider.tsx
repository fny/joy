import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
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

    const generateId = useCallback(() => {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }, []);

    const showModal = useCallback((config: Omit<ModalConfig, 'id'>): string => {
        const id = generateId();
        const modalConfig: ModalConfig = { ...config, id } as ModalConfig;
        
        setState(prev => ({
            modals: [...prev.modals, modalConfig]
        }));
        
        return id;
    }, [generateId]);

    const hideModal = useCallback((id: string) => {
        setState(prev => ({
            modals: prev.modals.filter(modal => modal.id !== id)
        }));
    }, []);

    const hideAllModals = useCallback(() => {
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

    // Initialize ModalManager with functions
    useEffect(() => {
        Modal.setFunctions(showModal, hideModal, hideAllModals);
    }, [showModal, hideModal, hideAllModals]);

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
    // gone when the alert closed (#333). Later entries render above earlier
    // ones (RN/RNW Modal stack order); each keeps its own state.
    const renderModal = (modal: ModalConfig) => {
        switch (modal.type) {
            case 'alert':
                return (
                    <WebAlertModal
                        key={modal.id}
                        config={modal}
                        onClose={() => hideModal(modal.id)}
                    />
                );
            case 'confirm':
                return (
                    <WebAlertModal
                        key={modal.id}
                        config={modal}
                        onClose={() => hideModal(modal.id)}
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
                        onClose={() => hideModal(modal.id)}
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
