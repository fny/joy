import * as Haptics from 'expo-haptics';
import { guarded } from '@/utils/guardAsync';

// Best-effort feedback: Expo rejects when the native module is unavailable
// (simulator, web, a device with haptics off). That is logged, never thrown.
export const hapticsError: () => void = guarded(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error));

export const hapticsLight: () => void = guarded(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
