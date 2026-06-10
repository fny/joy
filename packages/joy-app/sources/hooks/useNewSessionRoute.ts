import { useSetting } from '@/sync/storage';

// Route for every "New session" affordance (header +, sidebar button, command
// palette, empty states). When the joy__newSessionDefault setting is on, all
// of them open the joy-tmux create page instead of the stock /new flow — the
// joy page takes the place of "New session" rather than living beside it.
export function useNewSessionRoute(): '/new' | '/joy/new' {
    const joyDefault = useSetting('joy__newSessionDefault');
    return joyDefault ? '/joy/new' : '/new';
}
