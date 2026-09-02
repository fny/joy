// Model catalog for joy-tmux sessions.
//
// Keys are passed verbatim to `claude --model <key>` at session create and to
// the interactive `/model <key>` command when switching mid-session. All
// entries are bare family aliases — claude resolves each to the latest model
// of that family, so the catalog never needs touching on a model release.
// Order matters: the first entry is the default selection in /joy/new.
import type { ModelMode, PermissionMode } from '@/components/modelModeOptions';

export const JOY_CLAUDE_MODELS: ModelMode[] = [
    { key: 'opus', name: 'opus', description: null },
    { key: 'fable', name: 'fable', description: null },
    { key: 'sonnet', name: 'sonnet', description: null },
    { key: 'haiku', name: 'haiku', description: null },
];

// Permission modes for joy-tmux sessions, in the SAME order as interactive
// claude's Shift+Tab cycle (empirically, v2.1.170 launched with bypass
// available): bypass → auto → default → acceptEdits → plan. Matching the
// order means browser Shift+Tab cycling (AgentInput) visits modes in the
// same sequence as terminal Shift+Tab. Notably:
//   - includes 'auto' (real cycle member missing from the stock list)
//   - excludes 'dontAsk' (in the stock list but NOT in the interactive cycle —
//     joy-set-mode can't reach it and would error)
export const JOY_CLAUDE_PERMISSION_MODES: PermissionMode[] = [
    { key: 'bypassPermissions', name: 'yolo', description: null },
    { key: 'auto', name: 'auto', description: null },
    { key: 'default', name: 'default', description: null },
    { key: 'acceptEdits', name: 'accept edits', description: null },
    { key: 'plan', name: 'plan', description: null },
];

// Codex has its OWN approval/sandbox modes — the claude modes above (esp.
// `auto`) map WRONGLY onto codex and would silently escalate to full access
// (gpt-5.6-sol M2 finding #1). These keys are what the daemon's
// resolveCodexExecutionPolicy understands; the daemon fails closed on anything
// else. Order: safest first, `yolo` last so it's a deliberate pick.
//   default   → on-request + workspace-write (agent asks before running/patching)
//   read-only → on-request + read-only
//   safe-yolo → never + workspace-write (no prompts, workspace-confined)
//   yolo      → never + danger-full-access (no prompts, full access)
export const JOY_CODEX_PERMISSION_MODES: PermissionMode[] = [
    { key: 'default', name: 'default', description: null },
    { key: 'read-only', name: 'read only', description: null },
    { key: 'safe-yolo', name: 'safe yolo', description: null },
    { key: 'yolo', name: 'yolo', description: null },
];
