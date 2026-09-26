import React, { useEffect } from 'react';
import { AppState } from 'react-native';
import { endVoice, setVoiceForeground } from './RealtimeSession';

export const RealtimeProvider = ({ children }: { children: React.ReactNode }) => {
    useEffect(() => {
        void setVoiceForeground(AppState.currentState === 'active');
        const subscription = AppState.addEventListener('change', state => {
            void setVoiceForeground(state === 'active');
        });
        return () => { subscription.remove(); void endVoice(); };
    }, []);
    return <>{children}</>;
};
