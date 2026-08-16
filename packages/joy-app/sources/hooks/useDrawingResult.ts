import { create } from 'zustand';
import type { AttachmentPreview } from '@/sync/attachmentTypes';

// Hand-off channel from the full-screen drawing pad back to the session
// composer: the pad screen can't reach SessionView's useImagePicker instance
// directly (separate routes), so it deposits the captured attachment here and
// SessionView consumes it for the matching session (see the effect there).
interface DrawingResultState {
    sessionId: string | null;
    image: AttachmentPreview | null;
    deposit: (sessionId: string, image: AttachmentPreview) => void;
    consume: () => void;
}

export const useDrawingResult = create<DrawingResultState>((set) => ({
    sessionId: null,
    image: null,
    deposit: (sessionId, image) => set({ sessionId, image }),
    consume: () => set({ sessionId: null, image: null }),
}));
