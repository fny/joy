// Model catalog for joy-tmux sessions.
//
// Keys are passed verbatim to `claude --model <key>` at session create and to
// the interactive `/model <key>` command when switching mid-session, so both
// bare aliases (opus/sonnet/haiku → latest of each family) and full model ids
// (claude-opus-4-8, claude-fable-5) are valid. joy-tmux validates against
// /^[a-zA-Z0-9:._/-]{1,128}$/.
//
// This intentionally diverges from happy's getClaudeModelModes(): joy is a
// personal build, so the list carries the models actually in use (Opus 4.8,
// Fable 5) rather than the lowest-common-denominator aliases.
import type { ModelMode, PermissionMode } from '@/components/modelModeOptions';

export const JOY_CLAUDE_MODELS: ModelMode[] = [
    { key: 'default', name: 'default model', description: null },
    { key: 'claude-opus-4-8', name: 'opus 4.8', description: null },
    { key: 'claude-fable-5', name: 'fable 5', description: null },
    { key: 'opus', name: 'opus (latest)', description: null },
    { key: 'sonnet', name: 'sonnet (latest)', description: null },
    { key: 'haiku', name: 'haiku (latest)', description: null },
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
