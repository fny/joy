/**
 * Which default-override fields the Agent Defaults screen may offer per agent,
 * and with which options (#171). The generic option helpers fall through to
 * Claude's catalogue for any unknown flavor, so OpenCode, Pi and Antigravity
 * used to be offered opus/sonnet/haiku and Claude permission modes — values
 * those agents cannot honour, persisted as their defaults.
 *
 * Rules, from sources/sync/agentDefaults.ts:
 *  - opencode / pi: no permission surface; models come from the daemon's
 *    per-machine catalogue (joy-opencode-models), not a hardcoded list.
 *  - agy (Antigravity): permissions are always skipped; the CLI's own default model.
 *  - openclaw: a single "default model"; its own permission modes.
 */
import type { AgentKey } from '@/sync/agentDefaults';
import type { ModeOption } from '@/components/modelModeOptions';

export type OptionLookup = (agent: AgentKey) => ModeOption[];

/** Agents whose permission mode the app cannot set. */
export function supportsPermissionDefault(agent: AgentKey): boolean {
    return agent !== 'opencode' && agent !== 'pi' && agent !== 'agy';
}

/** Agents whose model catalogue the app can enumerate without the daemon. */
export function supportsModelDefault(agent: AgentKey): boolean {
    return agent !== 'opencode' && agent !== 'pi' && agent !== 'agy';
}

export function permissionOptionsFor(agent: AgentKey, hardcoded: OptionLookup): ModeOption[] {
    return supportsPermissionDefault(agent) ? hardcoded(agent) : [];
}

export function modelOptionsFor(agent: AgentKey, hardcoded: OptionLookup): ModeOption[] {
    if (!supportsModelDefault(agent)) return [];
    return hardcoded(agent).filter((option) => option.key !== 'default');
}

/**
 * An existing override the agent cannot honour (a Claude model saved under
 * OpenCode, say). Surfaced as a "clear this" row rather than silently shown as
 * selected, and never offered again.
 */
export function isUnsupportedOverride(
    agent: AgentKey,
    field: 'permissionMode' | 'modelMode' | 'effortLevel',
    value: string | undefined,
    options: ModeOption[],
): boolean {
    if (value === undefined) return false;
    if (field === 'permissionMode' && !supportsPermissionDefault(agent)) return true;
    if (field === 'modelMode' && !supportsModelDefault(agent)) return true;
    return !options.some((option) => option.key === value);
}
