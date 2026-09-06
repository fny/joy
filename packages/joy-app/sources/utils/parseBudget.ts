/**
 * Work budgets for parsers that run on the UI thread.
 *
 * Message text, tool output and code blocks are attacker/agent-controlled and
 * several of our regex/loop parsers had super-linear worst cases: a quoted
 * 64k-digit literal froze the highlighter for seconds (#241), a run of
 * unclosed "[" or "(" made the markdown span parser quadratic, repeated
 * unfinished <joy-img tags did the same to message splitting, repeated "a/ "
 * tokens made file-link parsing cubic (#446), unclosed <tool_use_error>
 * tags made error classification quadratic (#458).
 *
 * Two knobs, used together with linear-time regexes at every parse site:
 *  - an INPUT cap: past it the parser returns the input as plain text —
 *    nobody reads highlighting on a 200k-character block anyway;
 *  - an ITERATION budget: the parser spends one unit per candidate/match and
 *    degrades to plain text for the remainder once the budget is exhausted,
 *    so total work is bounded regardless of how the input is shaped.
 *
 * The fallback is always the ORIGINAL text, never truncation: the user still
 * sees everything, just without decoration.
 */

/** Characters of input past which a decorating parser returns plain text. */
export const PARSE_INPUT_CAP = 200_000;

/** Default number of matches/candidates a single parse may examine. */
export const PARSE_ITERATION_CAP = 50_000;

/** True when `text` is too long to decorate; callers return it verbatim. */
export function exceedsInputBudget(text: string, cap: number = PARSE_INPUT_CAP): boolean {
    return text.length > cap;
}

export class ParseBudget {
    private remaining: number;
    readonly limit: number;

    constructor(limit: number) {
        this.limit = Math.max(0, Math.floor(limit));
        this.remaining = this.limit;
    }

    /**
     * Charge `units` of work. Returns false (and stays exhausted) once the
     * budget is spent, so `while (m = re.exec(s)) { if (!budget.spend()) break; }`
     * bounds any match loop.
     */
    spend(units: number = 1): boolean {
        if (this.remaining <= 0) return false;
        this.remaining -= units;
        return this.remaining >= 0;
    }

    get exhausted(): boolean {
        return this.remaining <= 0;
    }
}

export function parseBudget(limit: number = PARSE_ITERATION_CAP): ParseBudget {
    return new ParseBudget(limit);
}
