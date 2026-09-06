import * as Clipboard from 'expo-clipboard';
import { Modal } from '@/modal';
import { t } from '@/text';
import { log } from '@/log';

/**
 * Write to the clipboard and report whether it actually landed.
 *
 * expo-clipboard resolves `false` when the browser refuses the write (no
 * permission, no user gesture, insecure context) and rejects on native
 * failures. Every copy button ignored both and announced "Copied" while the
 * clipboard kept its previous contents. Callers show success only on `true`;
 * a failure is shown here (t('common.copyFailed'), or `failureMessage`),
 * unless `silent` because the caller renders its own failure state.
 */
export async function copyToClipboard(
    text: string,
    opts: { failureMessage?: string; silent?: boolean } = {},
): Promise<boolean> {
    let ok = false;
    try {
        ok = (await Clipboard.setStringAsync(text)) === true;
    } catch (e) {
        console.warn('[clipboard] write failed:', e);
        log.log(`[clipboard] write failed: ${e instanceof Error ? e.message : String(e)}`);
        ok = false;
    }
    if (!ok && !opts.silent) {
        Modal.alert(t('common.error'), opts.failureMessage ?? t('common.copyFailed'));
    }
    return ok;
}
