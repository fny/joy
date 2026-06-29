export const VOICE_UPSELL_FLAG_KEY = 'voice-upsell';

export type VoiceUpsellVariant =
    | 'show-paywall-before-first-voice-chat'
    | 'voice-onboarding-and-upsell'
    | 'control';

export type VoiceUpsellVariantSource = 'override' | 'posthog' | 'default';

export type VoiceGatingMode = 'direct-byo-agent' | 'happy-server';

function isVoiceUpsellVariant(value: unknown): value is Exclude<VoiceUpsellVariant, 'control'> {
    return value === 'show-paywall-before-first-voice-chat' || value === 'voice-onboarding-and-upsell';
}

export function getVoiceUpsellVariantLabel(variant: VoiceUpsellVariant): string {
    switch (variant) {
        case 'control':
            return 'Control';
        case 'show-paywall-before-first-voice-chat':
            return 'Soft paywall before first voice chat';
        case 'voice-onboarding-and-upsell':
            return 'Voice onboarding and upsell';
    }
}

export function applyVoiceUpsellOverride(_override: VoiceUpsellVariant | null) {
    // Feature-flag overrides were applied through the analytics client, which has
    // been removed. Without a flag provider there is nothing to override.
}

export function getVoiceUpsellVariant(options?: {
    rawVariant?: unknown;
    override?: VoiceUpsellVariant | null;
    overrideEnabled?: boolean;
}): VoiceUpsellVariant {
    if (options?.overrideEnabled && options.override) {
        return options.override;
    }

    const rawVariant = options?.rawVariant ?? undefined;
    if (isVoiceUpsellVariant(rawVariant)) {
        return rawVariant;
    }
    return 'control';
}

export function getVoiceExperimentStatus(options: {
    voiceBypassToken: boolean;
    voiceCustomAgentId: string | null | undefined;
    voiceUpsellOverride?: VoiceUpsellVariant | null;
    voiceUpsellOverrideEnabled?: boolean;
}): {
    upsellVariant: VoiceUpsellVariant;
    upsellVariantSource: VoiceUpsellVariantSource;
    gatingMode: VoiceGatingMode;
} {
    const rawVariant = undefined;
    const gatingMode: VoiceGatingMode = options.voiceBypassToken && !!options.voiceCustomAgentId
        ? 'direct-byo-agent'
        : 'happy-server';
    const hasOverride = !!options.voiceUpsellOverrideEnabled && !!options.voiceUpsellOverride;

    return {
        upsellVariant: getVoiceUpsellVariant({
            rawVariant,
            override: options.voiceUpsellOverride,
            overrideEnabled: options.voiceUpsellOverrideEnabled,
        }),
        upsellVariantSource: hasOverride ? 'override' : isVoiceUpsellVariant(rawVariant) ? 'posthog' : 'default',
        gatingMode,
    };
}
