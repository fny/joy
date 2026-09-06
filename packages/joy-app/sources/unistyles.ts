import { StyleSheet, UnistylesRuntime } from 'react-native-unistyles';
import { darkTheme, lightTheme } from './theme';
import { loadThemePreference, loadPaletteState } from './sync/persistence';
import { applyAppearance, applyDarkAppearance } from './palettes';
import { setDefaultFontFamily } from './constants/Typography';
import { Appearance, Platform } from 'react-native';
import * as SystemUI from 'expo-system-ui';
import { planVisibilityResync } from './visibilityThemeResync';

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
const { themePalette, themePaletteDark, customPalette, accentOverrides, fontOverride } = loadPaletteState();
setDefaultFontFamily(fontOverride);
applyAppearance(themePalette, customPalette, accentOverrides);
applyDarkAppearance(themePaletteDark);

// Re-sync theme when tab becomes visible (web only — Appearance API may miss changes while hidden).
// Guarded on `document`: this module is also imported by app/+html.tsx, which
// Expo evaluates in Node during static rendering (Platform.OS is 'web' there
// but there is no DOM) — an unguarded listener threw "document is not defined"
// and aborted the HTML export before Root could render (#184).
//
// The listener is registered regardless of the STARTUP preference and reads
// the preference and palette state at event time: it used to close over the
// boot-time values, so after switching to fixed Light or picking another
// palette, revisiting the tab re-enabled adaptive themes, flipped to the OS
// scheme and restored the startup palette (#420). loadThemePreference and
// loadPaletteState read the persisted settings on every call.
if (Platform.OS === 'web' && typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        const plan = planVisibilityResync(loadThemePreference(), Appearance.getColorScheme());
        if (!plan) return; // a fixed preference is never overridden by the OS scheme
        // Toggle adaptive off, set correct theme, toggle back on
        UnistylesRuntime.setAdaptiveThemes(false);
        UnistylesRuntime.setTheme(plan.theme);
        UnistylesRuntime.setAdaptiveThemes(true);
        // Re-apply the resolved theme's CURRENT palette (and its background) —
        // setTheme alone reverts to the stock theme without the palette override.
        const palette = loadPaletteState();
        if (plan.theme === 'dark') applyDarkAppearance(palette.themePaletteDark);
        else applyAppearance(palette.themePalette, palette.customPalette, palette.accentOverrides);
    });
}
