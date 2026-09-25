import React, { useEffect } from 'react';
import { AppState } from 'react-native';
import { endVoice } from './RealtimeSession';

export const RealtimeProvider = ({ children }: { children: React.ReactNode }) => {
    useEffect(() => {
        const subscription = AppState.addEventListener('change', state => {
            if (state !== 'active') void endVoice();
        });
        return () => { subscription.remove(); void endVoice(); };
    }, []);
    return <>{children}</>;
};
