import * as React from 'react';
import { ItemList } from '@/components/ItemList';
import { PaletteControls } from '@/components/dev/PaletteControls';

export default React.memo(function PaletteSettingsScreen() {
    return (
        <ItemList style={{ paddingTop: 0 }}>
            <PaletteControls />
        </ItemList>
    );
});
