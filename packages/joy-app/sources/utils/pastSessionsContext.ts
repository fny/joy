/**
 * Identity of the "past sessions" list on the new-session screen (#153).
 *
 * The list of resumable conversations is fetched for ONE machine, directory
 * and harness. It used to survive a change of any of them (and a slow
 * response for the old context could land after the change), so a row from
 * project A could be submitted as a resume id against project B. Everything
 * about the list — its rows, its open state, its in-flight request — is
 * keyed by this string; a different key means "start over".
 */
export function pastSessionsContextKey(input: {
    machineId: string | null | undefined;
    cwd: string;
    agent: string;
}): string {
    return `${input.machineId ?? ''} ${input.cwd} ${input.agent}`;
}
