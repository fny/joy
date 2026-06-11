import * as React from 'react';
import { Text } from 'react-native';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { useLocalSettingMutable } from '@/sync/storage';
import { FONT_OPTIONS, setDefaultFontFamily } from '@/constants/Typography';
import { applyAppearance } from '@/palettes';

// Dev font picker — overrides the default (body/UI) font family. Mono and logo
// fonts are left alone. Applies live (with a theme nudge to reflow styles) and
// fully on reload.
export const FontControls = React.memo(function FontControls() {
    const [fontOverride, setFontOverride] = useLocalSettingMutable('fontOverride');
    const [themePalette] = useLocalSettingMutable('themePalette');
    const [customPalette] = useLocalSettingMutable('customPalette');
    const [accentOverrides] = useLocalSettingMutable('accentOverrides');

    const select = React.useCallback((family: string | null) => {
        setFontOverride(family);
        setDefaultFontFamily(family);
        // Nudge a reflow so styles that bake in the default font recompute.
        applyAppearance(themePalette, customPalette, accentOverrides);
    }, [themePalette, customPalette, accentOverrides, setFontOverride]);

    return (
        <ItemGroup title="Font" footer="Overrides the default UI font. Code/mono text is unchanged. Some text only fully updates on reload.">
            {FONT_OPTIONS.map((opt) => (
                <Item
                    key={opt.id}
                    title={opt.label}
                    selected={(fontOverride ?? null) === (opt.family ?? null)}
                    rightElement={<Text style={{ fontFamily: opt.family ?? undefined, fontSize: 17 }}>Ag</Text>}
                    onPress={() => select(opt.family)}
                />
            ))}
        </ItemGroup>
    );
});
