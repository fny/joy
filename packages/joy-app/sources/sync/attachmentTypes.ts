/**
 * Shared types for image attachment upload pipeline.
 * Defined here (not in hooks/) to avoid circular dependencies:
 * hooks/ imports from sync/, so sync/ cannot import from hooks/.
 */

export type AttachmentPreview = {
    /** Stable unique identifier for use as React key and for removal. */
    id: string;
    uri: string;
    width: number;
    height: number;
    mimeType: string;
    /** May be 0 if the system did not provide the file size. */
    size: number;
    name: string;
    thumbhash?: string;
};
