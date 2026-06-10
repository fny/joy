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
//   - includes 'auto' (real cycle member missing from happy's list)
//   - excludes 'dontAsk' (in happy's list but NOT in the interactive cycle —
//     joy-set-mode can't reach it and would error)
export const JOY_CLAUDE_PERMISSION_MODES: PermissionMode[] = [
    { key: 'bypassPermissions', name: 'yolo', description: null },
    { key: 'auto', name: 'auto', description: null },
    { key: 'default', name: 'default', description: null },
    { key: 'acceptEdits', name: 'accept edits', description: null },
    { key: 'plan', name: 'plan', description: null },
];
