import { useCameraPermissions } from "expo-camera";
import { Platform } from "react-native";

export function useCheckScannerPermissions(): () => Promise<boolean> {
    const [cameraPermission, requestCameraPermission] = useCameraPermissions();

    return async () => {
        if (Platform.OS === 'android') {
            // adroid uses google code scanner which doesn't need permissions
            return true;
        }

        if (!cameraPermission) {
            // camera permissions are loading
            return false;
        }

        if (!cameraPermission.granted) {
            const reqRes = await requestCameraPermission();
            return reqRes.granted;
        }

        return true;
    }
}

/** expo-camera rejects `launchScanner` when the user backs out of Android's
 *  code scanner (BarcodeScanningCancelledException). Not an error. */
export function isScannerCancellation(error: unknown): boolean {
    const e = error as { code?: unknown; name?: unknown; message?: unknown } | null;
    return /cancel/i.test(`${e?.code ?? ''} ${e?.name ?? ''} ${e?.message ?? ''}`);
}