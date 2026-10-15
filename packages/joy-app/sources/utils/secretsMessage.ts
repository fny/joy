// Secrets typed into the message box. Two forms, any number of each, each
// starting its own line anywhere in the message (`/secret` works too):
//
//   ```secrets                    /secrets email=me@x.com password="two words"
//   email: me@x.com
//   password: hunter2
//   ```
//
// On send the app takes them out of the message, saves the values to the
// session's machine over the sealed tunnel (the daemon's secrets store), and
// sends the rest with a one-line note naming them in their place — the agent
// reads a value with `joy secret get <name>`. While typing, the composer
// shows which names are new and which replace a saved one.

/** Same rule as the daemon (secretsStore.isValidSecretName). */
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

export interface ParsedSecrets {
    /** name → value, in the order typed; a later duplicate wins. */
    secrets: Record<string, string>;
    /** The message with every secrets block and /secrets line taken out. */
    rest: string;
    /** Lines inside a secrets block (or tokens of a /secrets line) that are
     *  not `name: value` / `name=value` — sending is refused while any exist. */
    invalid: string[];
}

// An unclosed block runs to the end of the text: while typing, the strip
// already shows what will be saved.
const BLOCK_RE = /(^|\n)[ \t]*```secrets[ \t]*\n([\s\S]*?)(?:\n[ \t]*```[ \t]*(?=\n|$)|$)/g;
const SLASH_RE = /(^|\n)[ \t]*\/secrets?(?:[ \t]+([^\n]*))?(?=\n|$)/g;

function splitPair(line: string, seps: string[]): [string, string] | null {
    let at = -1;
    for (const sep of seps) {
        const i = line.indexOf(sep);
        if (i > 0 && (at < 0 || i < at)) at = i;
    }
    if (at < 0) return null;
    const name = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
    return NAME_RE.test(name) && value.length > 0 ? [name, value] : null;
}

/** `a=1 b="two words" c='x'` → tokens, quotes honoured. */
function slashTokens(s: string): string[] {
    const out: string[] = [];
    const re = /[^\s"']*(?:"[^"]*"|'[^']*')?[^\s"']*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
        if (m[0] === '') { re.lastIndex += 1; if (re.lastIndex > s.length) break; continue; }
        out.push(m[0]);
    }
    return out;
}

/** The secrets in a message, or null when it has none (not even an empty block). */
export function parseSecretsMessage(text: string): ParsedSecrets | null {
    const secrets: Record<string, string> = {};
    const invalid: string[] = [];
    let found = false;
    let rest = text.replace(BLOCK_RE, (_m, lead: string, body: string) => {
        found = true;
        for (const raw of body.split('\n')) {
            const line = raw.trim();
            if (!line) continue;
            const pair = splitPair(line, [':', '=']);
            if (pair) secrets[pair[0]] = pair[1]; else invalid.push(line);
        }
        return lead;
    });
    rest = rest.replace(SLASH_RE, (m, lead: string, args: string | undefined) => {
        const tokens = slashTokens(args ?? '');
        // A bare `/secrets` saves nothing: it stays in the message as typed.
        if (tokens.length === 0) return m;
        found = true;
        for (const tok of tokens) {
            const pair = splitPair(tok, ['=']);
            if (pair) secrets[pair[0]] = pair[1]; else invalid.push(tok);
        }
        return lead;
    });
    if (!found) return null;
    return { secrets, rest: rest.replace(/\n{3,}/g, '\n\n').trim(), invalid };
}

/** What the agent sees in place of the secrets. */
export function secretsNote(names: string[]): string {
    return `[secrets saved: ${names.join(', ')} — read one with \`joy secret get <name>\`]`;
}

/** The message the agent gets: the rest of what was typed, then the note. */
export function messageWithSecretsNote(rest: string, names: string[]): string {
    const note = secretsNote(names);
    return rest ? `${rest}\n\n${note}` : note;
}

/** Each typed name, and whether it replaces one already saved (names match
 *  without regard to case, as on the daemon). */
export function secretsPreview(secrets: Record<string, string>, saved: readonly string[] | null): Array<{ name: string; replaces: boolean }> {
    const have = new Set((saved ?? []).map((n) => n.toLowerCase()));
    return Object.keys(secrets).map((name) => ({ name, replaces: have.has(name.toLowerCase()) }));
}
