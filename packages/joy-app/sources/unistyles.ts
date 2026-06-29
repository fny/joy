import { StyleSheet, UnistylesRuntime } from 'react-native-unistyles';
import { darkTheme, lightTheme } from './theme';
import { loadThemePreference, loadPaletteState } from './sync/persistence';
import { applyAppearance, applyDarkAppearance } from './palettes';
import { setDefaultFontFamily, setMonoFontFamily } from './constants/Typography';
import { Appearance, Platform } from 'react-native';
import * as SystemUI from 'expo-system-ui';

//
// Theme
//

const appThemes = {
    light: lightTheme,
    dark: darkTheme
};

const breakpoints = {
    xs: 0, // <-- make sure to register one breakpoint with value 0
    sm: 300,
    md: 500,
    lg: 800,
    xl: 1200
    // use as many breakpoints as you need
};

// Load theme preference from storage
const themePreference = loadThemePreference();

// Determine initial theme and adaptive settings
const getInitialTheme = (): 'light' | 'dark' => {
    if (themePreference === 'adaptive') {
        const systemTheme = Appearance.getColorScheme();
        return systemTheme === 'dark' ? 'dark' : 'light';
    }
    return themePreference;
};

const settings = themePreference === 'adaptive'
    ? {
        // When adaptive, let Unistyles handle theme switching automatically
        adaptiveThemes: true,
        CSSVars: true, // Enable CSS variables for web
    }
    : {
        // When fixed theme, set the initial theme explicitly
        initialTheme: getInitialTheme(),
        CSSVars: true, // Enable CSS variables for web
    };

//
// Bootstrap
//

type AppThemes = typeof appThemes
type AppBreakpoints = typeof breakpoints

declare module 'react-native-unistyles' {
    export interface UnistylesThemes extends AppThemes { }
    export interface UnistylesBreakpoints extends AppBreakpoints { }
}

StyleSheet.configure({
    settings,
    breakpoints,
    themes: appThemes,
})

// Set initial root view background color based on theme
const setRootBackgroundColor = () => {
    if (themePreference === 'adaptive') {
        const systemTheme = Appearance.getColorScheme();
        const color = systemTheme === 'dark' ? appThemes.dark.colors.groupped.background : appThemes.light.colors.groupped.background;
        UnistylesRuntime.setRootViewBackgroundColor(color);
        SystemUI.setBackgroundColorAsync(color);
    } else {
        const color = themePreference === 'dark' ? appThemes.dark.colors.groupped.background : appThemes.light.colors.groupped.background;
        UnistylesRuntime.setRootViewBackgroundColor(color);
        SystemUI.setBackgroundColorAsync(color);
    }
};

// Set initial background color
setRootBackgroundColor();

// Apply the saved appearance (palette shell + accent overrides) to the light theme.
const { themePalette, themePaletteDark, customPalette, accentOverrides, fontOverride, monoOverride } = loadPaletteState();
setDefaultFontFamily(fontOverride);
setMonoFontFamily(monoOverride);
applyAppearance(themePalette, customPalette, accentOverrides);
applyDarkAppearance(themePaletteDark);

// Re-sync theme when tab becomes visible (web only — Appearance API may miss changes while hidden)
if (Platform.OS === 'web' && themePreference === 'adaptive') {
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            const themeName = Appearance.getColorScheme() === 'dark' ? 'dark' : 'light';
            // Toggle adaptive off, set correct theme, toggle back on
            UnistylesRuntime.setAdaptiveThemes(false);
            UnistylesRuntime.setTheme(themeName);
            UnistylesRuntime.setAdaptiveThemes(true);
            // Re-apply the resolved theme's palette (and its background) — setTheme
            // alone reverts to the stock theme without the palette override.
            if (themeName === 'dark') applyDarkAppearance(themePaletteDark);
            else applyAppearance(themePalette, customPalette, accentOverrides);
        }
    });
}