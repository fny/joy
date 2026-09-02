import React from 'react';
import { RealtimeVoiceSession } from './RealtimeVoiceSession';
import { useVoiceSessionGeneration } from '@/sync/storage';

export const RealtimeProvider = ({ children }: { children: React.ReactNode }) => {
    // The web SDK has no LiveKit Room to go stale; the re-key is defensive and
    // keeps the two platforms symmetric.
    const generation = useVoiceSessionGeneration();
    return (
        <>
            <RealtimeVoiceSession key={generation} />
            {children}
        </>
    );
};
