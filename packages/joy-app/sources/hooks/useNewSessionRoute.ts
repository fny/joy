// Route for every "New session" affordance (header +, sidebar button, command
// palette, empty states). This build is exclusively joy-tmux, so they always
// open the joy create page — the stock /new flow is no longer a user path.
export function useNewSessionRoute(): '/new' | '/joy/new' {
    return '/joy/new';
}
