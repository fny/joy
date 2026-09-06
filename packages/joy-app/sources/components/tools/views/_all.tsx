import { safeGet } from '@/utils/safeGet';
import * as React from 'react';
import { EditView } from './EditView';
import { BashView } from './BashView';
import { Message, ToolCall } from '@/sync/typesMessage';
import { Metadata } from '@/sync/storageTypes';
import { WriteView } from './WriteView';
import { TodoView } from './TodoView';
import { ExitPlanToolView } from './ExitPlanToolView';
import { MultiEditView } from './MultiEditView';
import { TaskView, TaskViewFull } from './TaskView';
import { BashViewFull } from './BashViewFull';
import { EditViewFull } from './EditViewFull';
import { MultiEditViewFull } from './MultiEditViewFull';
import { CodexBashView, CodexBashViewFull } from './CodexBashView';
import { CodexPatchView } from './CodexPatchView';
import { CodexDiffView } from './CodexDiffView';
import { AskUserQuestionView } from './AskUserQuestionView';
import { GeminiEditView } from './GeminiEditView';
import { GeminiExecuteView } from './GeminiExecuteView';

export type ToolViewProps = {
    tool: ToolCall;
    metadata: Metadata | null;
    messages: Message[];
    sessionId?: string;
    permissionFooter?: React.ReactNode;
}

// Type for tool view components
export type ToolViewComponent = React.ComponentType<ToolViewProps>;

// Registry of tool-specific view components
export const toolViewRegistry: Record<string, ToolViewComponent> = {
    Edit: EditView,
    Bash: BashView,
    CodexBash: CodexBashView,
    CodexPatch: CodexPatchView,
    GeminiPatch: CodexPatchView,
    CodexDiff: CodexDiffView,
    GeminiDiff: CodexDiffView,
    Write: WriteView,
    TodoWrite: TodoView,
    ExitPlanMode: ExitPlanToolView,
    exit_plan_mode: ExitPlanToolView,
    MultiEdit: MultiEditView,
    Task: TaskView,
    Agent: TaskView,
    AskUserQuestion: AskUserQuestionView,
    // Gemini tools (lowercase)
    edit: GeminiEditView,
    execute: GeminiExecuteView,
    // File attachment events
};

export const toolFullViewRegistry: Record<string, ToolViewComponent> = {
    Bash: BashViewFull,
    CodexBash: CodexBashViewFull,
    Edit: EditViewFull,
    MultiEdit: MultiEditViewFull,
    Task: TaskViewFull,
    Agent: TaskViewFull,
};

// Registry lookups are OWN-property only: a tool named "__proto__" or
// "constructor" used to resolve to Object.prototype / the Object function,
// which React then tried to render as a component and crashed (#293).
export function getToolViewComponent(toolName: string): ToolViewComponent | null {
    return safeGet(toolViewRegistry, toolName) ?? null;
}

export function getToolFullViewComponent(toolName: string): ToolViewComponent | null {
    return safeGet(toolFullViewRegistry, toolName) ?? null;
}

// Export individual components
export { EditView } from './EditView';
export { BashView } from './BashView';
export { CodexBashView, CodexBashViewFull } from './CodexBashView';
export { CodexPatchView } from './CodexPatchView';
export { CodexDiffView } from './CodexDiffView';
export { BashViewFull } from './BashViewFull';
export { EditViewFull } from './EditViewFull';
export { MultiEditViewFull } from './MultiEditViewFull';
export { ExitPlanToolView } from './ExitPlanToolView';
export { MultiEditView } from './MultiEditView';
export { TaskView, TaskViewFull } from './TaskView';
export { AskUserQuestionView } from './AskUserQuestionView';
export { GeminiEditView } from './GeminiEditView';
export { GeminiExecuteView } from './GeminiExecuteView';
