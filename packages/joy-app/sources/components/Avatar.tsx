import * as React from "react";
import { View } from "react-native";
import { Image } from "expo-image";
import { AvatarIdenticon, type AvatarVariant } from "./AvatarIdenticon";
import { useSetting } from '@/sync/storage';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

interface AvatarProps {
    id: string;
    title?: boolean;
    square?: boolean;
    size?: number;
    monochrome?: boolean;
    flavor?: string | null;
    imageUrl?: string | null;
    thumbhash?: string | null;
    /** Override Appearance → Identicons for this one mark (pinned rows). */
    variant?: AvatarVariant;
}

const flavorIcons = {
    claude: require('@/assets/images/icon-claude.png'),
    codex: require('@/assets/images/icon-gpt.png'),
    gemini: require('@/assets/images/icon-gemini.png'),
    openclaw: require('@/assets/images/icon-openclaw.png'),
    opencode: require('@/assets/images/icon-opencode.png'),
};

const styles = StyleSheet.create((theme) => ({
    container: {
        position: 'relative',
    },
    flavorIcon: {
        position: 'absolute',
        bottom: -2,
        right: -2,
        backgroundColor: theme.colors.surface,
        borderRadius: 100,
        padding: 2,
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.2,
        shadowRadius: 2,
        elevation: 3,
    },
}));

/**
 * The harness badge, sized from the avatar.
 *
 * The circle is 35% of the avatar, but with a floor: at the small sizes the
 * pinned rows and the avatar-size setting (8-24) use, 35% is a 6px smudge that
 * says nothing about which harness is running. Below the floor the badge stops
 * shrinking and simply overhangs a little more.
 *
 * The icons inside are not the same weight, so each is scaled against the
 * circle rather than the avatar: codex is a dense square mark and claude a
 * heavier glyph, both of which read larger than the rest at the same box.
 */
const BADGE_MIN = 11;

function badgeSize(size: number, flavor: string) {
    // Floored so it stays readable, but never larger than the avatar it sits
    // on — at the bottom of the size range the floor would otherwise win and
    // the badge would swallow the mark.
    const circle = Math.min(Math.max(Math.round(size * 0.35), BADGE_MIN), size);
    const scale = flavor === 'codex' ? 0.8 : flavor === 'claude' ? 0.8 : 1;
    return { circle, icon: Math.round(circle * scale) };
}

export const Avatar = React.memo((props: AvatarProps) => {
    const { flavor, size = 48, imageUrl, thumbhash, variant, ...avatarProps } = props;
    const showFlavorIcons = useSetting('showFlavorIcons');
    const { theme } = useUnistyles();

    // Render custom image if provided
    if (imageUrl) {
        const imageElement = (
            <Image
                source={{ uri: imageUrl, thumbhash: thumbhash || undefined }}
                placeholder={thumbhash ? { thumbhash: thumbhash } : undefined}
                contentFit="cover"
                style={{
                    width: size,
                    height: size,
                    borderRadius: avatarProps.square ? 0 : size / 2
                }}
            />
        );

        // Add flavor icon overlay if enabled
        if (showFlavorIcons && flavor) {
            const effectiveFlavor = flavor || 'claude';
            const flavorIcon = flavorIcons[effectiveFlavor as keyof typeof flavorIcons] || flavorIcons.claude;
            const { circle: circleSize, icon: iconSizePx } = badgeSize(size, effectiveFlavor);
            const iconSize = iconSizePx;

            return (
                <View style={[styles.container, { width: size, height: size }]}>
                    {imageElement}
                    <View style={[styles.flavorIcon, {
                        width: circleSize,
                        height: circleSize,
                        alignItems: 'center',
                        justifyContent: 'center'
                    }]}>
                        <Image
                            source={flavorIcon}
                            style={{ width: iconSize, height: iconSize }}
                            contentFit="contain"
                            tintColor={effectiveFlavor === 'codex' ? theme.colors.text : undefined}
                        />
                    </View>
                </View>
            );
        }

        return imageElement;
    }

    // Generated identicon — variant per Appearance → Identicons (hashicon in
    // joy-palette colors, or the square/circular confetti grids).
    const AvatarComponent: React.ComponentType<any> = AvatarIdenticon;

    // Determine flavor icon for generated avatars
    const effectiveFlavor = flavor || 'claude';
    const flavorIcon = flavorIcons[effectiveFlavor as keyof typeof flavorIcons] || flavorIcons.claude;
    const { circle: circleSize, icon: iconSize } = badgeSize(size, effectiveFlavor);

    // Only wrap in container if showing flavor icons and flavor was provided
    if (showFlavorIcons && flavor !== null) {
        return (
            <View style={[styles.container, { width: size, height: size }]}>
                <AvatarComponent {...avatarProps} size={size} variant={variant} />
                <View style={[styles.flavorIcon, {
                    width: circleSize,
                    height: circleSize,
                    alignItems: 'center',
                    justifyContent: 'center'
                }]}>
                    <Image
                        source={flavorIcon}
                        style={{ width: iconSize, height: iconSize }}
                        contentFit="contain"
                        tintColor={effectiveFlavor === 'codex' ? theme.colors.text : undefined}
                    />
                </View>
            </View>
        );
    }

    // Return avatar without wrapper when not showing flavor icons
    return <AvatarComponent {...avatarProps} size={size} variant={variant} />;
});