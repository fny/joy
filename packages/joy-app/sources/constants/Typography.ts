import { Platform } from 'react-native';

/**
 * Typography system for Happy Coder app
 * 
 * Default typography: IBM Plex Sans
 * Monospace typography: IBM Plex Mono  
 * Logo typography: Bricolage Grotesque (specific use only)
 * 
 * Usage Examples:
 * 
 * // Default typography (IBM Plex Sans)
 * <Text style={{ fontSize: 16, ...Typography.default() }}>Regular text</Text>
 * <Text style={{ fontSize: 16, ...Typography.default('italic') }}>Italic text</Text>
 * <Text style={{ fontSize: 16, ...Typography.default('semiBold') }}>Semi-bold text</Text>
 * 
 * // Monospace typography (IBM Plex Mono)
 * <Text style={{ fontSize: 14, ...Typography.mono() }}>Code text</Text>
 * <Text style={{ fontSize: 14, ...Typography.mono('italic') }}>Italic code</Text>
 * <Text style={{ fontSize: 14, ...Typography.mono('semiBold') }}>Bold code</Text>
 * 
 * // Logo typography (Bricolage Grotesque - use sparingly!)
 * // Note: Don't add fontWeight as this font is already bold
 * <Text style={{ fontSize: 28, ...Typography.logo() }}>Logo Text</Text>
 * 
 * // Alternative direct usage
 * <Text style={{ fontSize: 16, fontFamily: getDefaultFont('semiBold') }}>Direct usage</Text>
 * <Text style={{ fontSize: 14, fontFamily: getMonoFont() }}>Direct mono usage</Text>
 * <Text style={{ fontSize: 28, fontFamily: getLogoFont() }}>Direct logo usage</Text>
 */

// Font family constants
export const FontFamilies = {
  // IBM Plex Sans (default typography)
  default: {
    regular: 'IBMPlexSans-Regular',
    italic: 'IBMPlexSans-Italic', 
    semiBold: 'IBMPlexSans-SemiBold',
  },
  
  // IBM Plex Mono (default monospace)
  mono: {
    regular: 'IBMPlexMono-Regular',
    italic: 'IBMPlexMono-Italic',
    semiBold: 'IBMPlexMono-SemiBold',
  },
  
  // Bricolage Grotesque (logo/special use only)
  logo: {
    bold: 'BricolageGrotesque-Bold',
  },
  
  // Legacy fonts (keep for backward compatibility)
  legacy: {
    spaceMono: 'SpaceMono',
    systemMono: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  }
};

// Runtime override for the default (body/UI) font family — set by the dev font
// picker. When set, every Typography.default()/header()/body() usage (all routed
// through getDefaultFont) uses it instead of IBM Plex Sans. Mono and logo fonts
// are unaffected.
let overrideDefaultFamily: string | null = null;
export const setDefaultFontFamily = (family: string | null) => { overrideDefaultFamily = family; };
export const getDefaultFontOverride = () => overrideDefaultFamily;

// Runtime override for the MONOSPACE family (code blocks + mono UI). When set,
// every Typography.mono() usage (routed through getMonoFont) uses it instead of
// IBM Plex Mono. null = IBM Plex Mono.
let overrideMonoFamily: string | null = null;
export const setMonoFontFamily = (family: string | null) => { overrideMonoFamily = family; };
export const getMonoFontOverride = () => overrideMonoFamily;

export interface FontOption { id: string; label: string; family: string | null }

// Body/UI font sets, grouped by category. `family: null` = the built-in default
// (IBM Plex Sans). Bundled custom fonts work everywhere; the system/serif/popular
// stacks resolve on web + desktop and degrade gracefully to a native family.
export const FONT_SETS: { category: string; options: FontOption[] }[] = [
  { category: 'Sans-serif', options: [
    { id: 'plex-sans', label: 'IBM Plex Sans (default)', family: null },
    { id: 'system-sans', label: 'System', family: Platform.select({ ios: 'System', android: 'sans-serif', default: 'system-ui, sans-serif' }) ?? null },
    { id: 'helvetica', label: 'Helvetica / Arial', family: Platform.select({ ios: 'Helvetica Neue', android: 'sans-serif', default: '"Helvetica Neue", Helvetica, Arial, sans-serif' }) ?? null },
    { id: 'verdana', label: 'Verdana', family: Platform.select({ ios: 'Verdana', android: 'sans-serif', default: 'Verdana, Geneva, sans-serif' }) ?? null },
  ] },
  { category: 'Serif', options: [
    { id: 'georgia', label: 'Georgia', family: Platform.select({ ios: 'Georgia', android: 'serif', default: 'Georgia, Cambria, "Times New Roman", serif' }) ?? null },
    { id: 'times', label: 'Times', family: Platform.select({ ios: 'Times New Roman', android: 'serif', default: '"Times New Roman", Times, serif' }) ?? null },
    { id: 'ui-serif', label: 'System Serif', family: Platform.select({ ios: 'Georgia', android: 'serif', default: 'ui-serif, serif' }) ?? null },
  ] },
  { category: 'Monospace', options: [
    { id: 'plex-mono', label: 'IBM Plex Mono', family: 'IBMPlexMono-Regular' },
    { id: 'space-mono', label: 'Space Mono', family: 'SpaceMono' },
    { id: 'system-mono', label: 'System Mono', family: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, SFMono-Regular, Menlo, monospace' }) ?? null },
  ] },
];

// Monospace override options for code/mono surfaces. `family: null` = IBM Plex Mono.
export const MONO_FONT_OPTIONS: FontOption[] = [
  { id: 'plex-mono', label: 'IBM Plex Mono (default)', family: null },
  { id: 'space-mono', label: 'Space Mono', family: 'SpaceMono' },
  { id: 'system-mono', label: 'System Mono', family: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, SFMono-Regular, Menlo, monospace' }) ?? null },
  { id: 'courier', label: 'Courier', family: Platform.select({ ios: 'Courier', android: 'monospace', default: '"Courier New", Courier, monospace' }) ?? null },
];

// Helper functions for easy access to font families
export const getDefaultFont = (weight: 'regular' | 'italic' | 'semiBold' = 'regular') => {
  return overrideDefaultFamily ?? FontFamilies.default[weight];
};

export const getMonoFont = (weight: 'regular' | 'italic' | 'semiBold' = 'regular') => {
  return overrideMonoFamily ?? FontFamilies.mono[weight];
};

export const getLogoFont = () => {
  return FontFamilies.logo.bold;
};

// Font weight mappings for the font families
export const FontWeights = {
  regular: '400',
  semiBold: '600', 
  bold: '700',
} as const;

// Style utilities for easy inline usage
export const Typography = {
  // Default font styles (IBM Plex Sans)
  default: (weight: 'regular' | 'italic' | 'semiBold' = 'regular') => ({
    fontFamily: getDefaultFont(weight),
  }),
  
  // Monospace font styles (IBM Plex Mono)
  mono: (weight: 'regular' | 'italic' | 'semiBold' = 'regular') => ({
    fontFamily: getMonoFont(weight),
  }),
  
  // Logo font style (Bricolage Grotesque)
  logo: () => ({
    fontFamily: getLogoFont(),
  }),
  
  // Header text style
  header: () => ({
    fontFamily: getDefaultFont('semiBold'),
  }),
  
  // Body text style
  body: () => ({
    fontFamily: getDefaultFont('regular'),
  }),
  
  // Legacy font styles (for backward compatibility)
  legacy: {
    spaceMono: () => ({
      fontFamily: FontFamilies.legacy.spaceMono,
    }),
    systemMono: () => ({
      fontFamily: FontFamilies.legacy.systemMono,
    }),
  }
}; 