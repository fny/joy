// The machine page is joy-tmux only in this build — render the joy machine
// view (daemon status, version, PID, OS) instead of the stock happy-daemon
// page.
import * as React from 'react';
import { useLocalSearchParams, Stack } from 'expo-router';
import { JoyMachineView } from '@/components/JoyMachineView';
import { t } from '@/text';

export default React.memo(function MachineScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    return (
        <>
            <Stack.Screen options={{ headerTitle: 'Machine', headerBackTitle: t('common.back') }} />
            <JoyMachineView machineId={id} />
        </>
    );
});
