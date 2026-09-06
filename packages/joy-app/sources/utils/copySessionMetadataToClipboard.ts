import { copyToClipboard } from '@/utils/clipboard';
import { Modal } from '@/modal';
import { Session } from '@/sync/storageTypes';
import { t } from '@/text';
import { log } from '@/log';

export async function copySessionMetadataToClipboard(session: Session): Promise<boolean> {
    if (!session.metadata) {
        Modal.alert(t('common.error'), t('sessionInfo.failedToCopyMetadata'));
        return false;
    }

    // A refused write (expo resolves false) and a rejected one both end here
    // as false with the failure alert shown by the helper.
    const ok = await copyToClipboard(JSON.stringify(session.metadata, null, 2), { failureMessage: t('sessionInfo.failedToCopyMetadata') });
    if (ok) Modal.alert(t('common.success'), t('sessionInfo.metadataCopied'));
    return ok;
}

export async function copySessionMetadataAndLogsToClipboard(session: Session): Promise<boolean> {
    if (!session.metadata) {
        Modal.alert(t('common.error'), t('sessionInfo.failedToCopyMetadata'));
        return false;
    }

    const metadata = JSON.stringify(session.metadata, null, 2);
    const logs = log.getLogs();

    const sections = [
        '=== Session Metadata ===',
        metadata,
    ];

    if (logs.length > 0) {
        sections.push(
            '',
            `=== Client Logs (${logs.length} entries) ===`,
            logs.join('\n'),
        );
    }

    const ok = await copyToClipboard(sections.join('\n'), { failureMessage: t('sessionInfo.failedToCopyMetadata') });
    if (ok) Modal.alert(t('common.success'), t('sessionInfo.metadataCopied'));
    return ok;
}
