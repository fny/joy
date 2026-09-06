import * as React from 'react';
import { knownTools } from '@/components/tools/knownTools';
import { formatMCPTitle } from '@/components/tools/views/MCPToolView';
import { Message, ToolCall } from '@/sync/typesMessage';
import { Metadata } from '@/sync/storageTypes';
import { getToolModel, ToolOutcome } from '@/sync/toolModel';
import { safeGet } from '@/utils/safeGet';
import { t } from '@/text';

/**
 * Presentation facts every tool surface (card header, detail header, group
 * row, Task preview) reads the same way. The `knownTools` accessors were
 * written against well-formed arguments (`input.file_path`), and a Read with
 * `input: null` or a CodexBash with `parsed_cmd: [null]` threw straight out of
 * the header render. Every accessor is called through `safely` here, so a
 * malformed item degrades to the tool name instead of a thrown render.
 */
export type ToolPresentation = {
    title: string;
    subtitle: string | null;
    status: string | null;
    /** Compact row without a body. */
    minimal: boolean;
    /** No running spinner (stateless tools such as TodoWrite). */
    noStatus: boolean;
    /** The specialized view renders its own failure; skip the generic error. */
    hideDefaultError: boolean;
    /** Internal tool — never rendered. */
    hidden: boolean;
    known: boolean;
    icon: ((size: number, color: string) => React.ReactNode) | null;
};

type KnownTool = {
    title?: string | ((opts: { metadata: Metadata | null; tool: ToolCall }) => string);
    icon?: (size: number, color: string) => React.ReactNode;
    noStatus?: boolean;
    hideDefaultError?: boolean;
    hidden?: boolean;
    isMutable?: boolean;
    minimal?: boolean | ((opts: { metadata: Metadata | null; tool: ToolCall; messages?: Message[] }) => boolean);
    extractDescription?: (opts: { metadata: Metadata | null; tool: ToolCall }) => string;
    extractSubtitle?: (opts: { metadata: Metadata | null; tool: ToolCall }) => string | null;
    extractStatus?: (opts: { metadata: Metadata | null; tool: ToolCall }) => string | null;
};

export function getKnownTool(name: string): KnownTool | null {
    return (safeGet(knownTools as Record<string, KnownTool>, name) as KnownTool | undefined) ?? null;
}

function safely<T>(compute: () => T, fallback: T): T {
    try {
        return compute();
    } catch {
        return fallback;
    }
}

function nonEmpty(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The accessors dereference `tool.input.<field>`; hand them a copy whose
 * `input` is the validated argument record so a null / array / string
 * argument payload cannot throw inside them.
 */
function withSafeInput(tool: ToolCall): ToolCall {
    const model = getToolModel(tool);
    if (model.arguments.ok) return tool;
    return { ...tool, input: model.arguments.value };
}

export function describeTool(tool: ToolCall, metadata: Metadata | null, messages?: Message[]): ToolPresentation {
    const known = getKnownTool(tool.name);
    const safeTool = withSafeInput(tool);
    const opts = { tool: safeTool, metadata };

    let title = tool.name;
    if (tool.name.startsWith('mcp__')) {
        title = safely(() => formatMCPTitle(tool.name), tool.name);
    } else if (known?.title) {
        const knownTitle = known.title;
        title = safely(() => (typeof knownTitle === 'function' ? knownTitle(opts) : knownTitle), tool.name) || tool.name;
    }

    const status = known?.extractStatus
        ? safely(() => nonEmpty(known.extractStatus!(opts)), null)
        : null;
    const subtitle = known?.extractSubtitle
        ? safely(() => nonEmpty(known.extractSubtitle!(opts)), null)
        : null;

    let minimal = false;
    if (!known && metadata?.flavor === 'gemini') {
        // Unknown Gemini-internal tools stay compact rather than dumping raw
        // INPUT / OUTPUT sections.
        minimal = true;
    }
    if (tool.name.startsWith('mcp__')) {
        minimal = true;
    }
    if (known && known.minimal !== undefined) {
        const knownMinimal = known.minimal;
        minimal = safely(() => (typeof knownMinimal === 'function' ? knownMinimal({ ...opts, messages }) : knownMinimal), minimal);
    }

    return {
        title,
        subtitle,
        status,
        minimal,
        noStatus: known?.noStatus === true,
        hideDefaultError: known?.hideDefaultError === true,
        hidden: known?.hidden === true,
        known: known !== null,
        icon: known?.icon ?? null,
    };
}

/** Row label for a nested tool (Task preview): description, else title, else name. */
export function describeChildTool(tool: ToolCall, metadata: Metadata | null): string {
    const known = getKnownTool(tool.name);
    if (!known) return tool.name;
    const opts = { tool: withSafeInput(tool), metadata };
    if (typeof known.extractDescription === 'function') {
        const description = safely(() => nonEmpty(known.extractDescription!(opts)), null);
        if (description) return description;
    }
    if (known.title) {
        const knownTitle = known.title;
        const title = safely(() => nonEmpty(typeof knownTitle === 'function' ? knownTitle(opts) : knownTitle), null);
        if (title) return title;
    }
    return tool.name;
}

export function toolOutcomeLabel(outcome: ToolOutcome): string {
    switch (outcome) {
        case 'failed':
            return t('tools.outcome.failed');
        case 'cancelled':
            return t('tools.outcome.cancelled');
        case 'denied':
            return t('tools.outcome.denied');
        case 'pending':
            return t('tools.outcome.pending');
        case 'succeeded':
            return t('tools.outcome.succeeded');
    }
}

/** Path of the single file a tool touches, for "open file" navigation. */
export function primaryFilePath(tool: ToolCall): string | null {
    const model = getToolModel(tool);
    if (model.fileChanges && model.fileChanges.length === 1 && model.fileChanges[0].path) {
        return model.fileChanges[0].path;
    }
    const filePath = model.arguments.value.file_path;
    return typeof filePath === 'string' && filePath.length > 0 ? filePath : null;
}
