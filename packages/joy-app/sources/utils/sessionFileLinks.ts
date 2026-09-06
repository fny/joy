import { exceedsInputBudget, parseBudget } from './parseBudget';

export type SessionFileLink = {
    path: string;
    absolutePath: string;
    relativePath: string | null;
    withinSessionRoot: boolean;
    line: number | null;
    column: number | null;
};

export type SessionFileTextSegment = {
    text: string;
    link: SessionFileLink | null;
};

const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;
// \\server\share\… — absolute too, or it was joined under the project root
// and reported as an in-project file (#452). Only the backslash form: a
// forward-slash "//x/y" is an ordinary (collapsible) POSIX path.
const UNC_PATH = /^\\\\[^\\/]+[\\/][^\\/]+/;
const POSIX_ABSOLUTE_PATH = /^\//;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const FILE_URL_PREFIX = /^file:\/\//i;
const RELATIVE_PREFIX = /^(?:\.{1,2}[\\/]|~[\\/])/;
const HAS_PATH_SEPARATOR = /[\\/]/;
const BARE_FILE_NAME = /^[^\\/\s]+\.[^\\/\s]+$/;
const NUMERIC_EXTENSION = /^\d+$/;
const FILE_EXTENSION = /^[A-Za-z0-9_-]{1,16}$/;
const EXTENSIONLESS_FILE_NAMES = new Set([
    'README',
    'LICENSE',
    'Makefile',
    'Dockerfile',
    '.gitignore',
    '.gitattributes',
    '.env',
    '.npmrc',
    '.yarnrc',
]);
const LEADING_WRAP = /^[([{<"'`]+/;
const TRAILING_WRAP = /[)\]}>",;!?`]+$/;
const APP_ROUTE_PREFIXES = ['/session/', '/text-selection', '/settings', '/auth'];

function parseLineAndColumn(value: string): { path: string; line: number | null; column: number | null } {
    const trimmed = value.trim();
    const lineColumnMatch = trimmed.match(/^(.*):(\d+):(\d+)$/);
    if (lineColumnMatch) {
        return {
            path: lineColumnMatch[1],
            line: Number.parseInt(lineColumnMatch[2], 10),
            column: Number.parseInt(lineColumnMatch[3], 10),
        };
    }

    const lineMatch = trimmed.match(/^(.*):(\d+)$/);
    if (!lineMatch) {
        return {
            path: trimmed,
            line: null,
            column: null,
        };
    }

    return {
        path: lineMatch[1],
        line: Number.parseInt(lineMatch[2], 10),
        column: null,
    };
}

function pushTextSegment(segments: SessionFileTextSegment[], text: string) {
    if (!text) {
        return;
    }
    const last = segments[segments.length - 1];
    if (last && last.link === null) {
        last.text += text;
        return;
    }
    segments.push({ text, link: null });
}

function stripToken(value: string): { leading: string; core: string; trailing: string } {
    const leading = value.match(LEADING_WRAP)?.[0] ?? '';
    const withoutLeading = leading ? value.slice(leading.length) : value;
    let trailing = withoutLeading.match(TRAILING_WRAP)?.[0] ?? '';
    let core = trailing ? withoutLeading.slice(0, withoutLeading.length - trailing.length) : withoutLeading;
    // A closing apostrophe is stripped only when an opening one was: '/repo/a.ts'
    // is a quoted path (#451), while an apostrophe that ends an unquoted name
    // belongs to it. Double quotes and backticks are in TRAILING_WRAP already.
    if (leading.includes("'") && core.endsWith("'")) {
        core = core.slice(0, -1);
        trailing = `'${trailing}`;
    }
    return { leading, core, trailing };
}

/**
 * file: URL → local path, or null when the URL names another host. The old
 * "strip the scheme, ensure a leading slash" produced /C:/Users/… for a
 * Windows drive and /localhost/home/… for the localhost authority (#449).
 */
function decodeFileUrl(value: string): string | null {
    if (!FILE_URL_PREFIX.test(value)) {
        return value;
    }
    const rest = value.replace(FILE_URL_PREFIX, '');
    let path: string;
    if (rest.startsWith('/')) {
        path = rest; // file:///… — empty authority
    } else {
        const slash = rest.indexOf('/');
        const authority = slash === -1 ? rest : rest.slice(0, slash);
        if (authority.toLowerCase() !== 'localhost') {
            return null; // a remote host is not a file this machine can open
        }
        path = slash === -1 ? '/' : rest.slice(slash);
    }
    try {
        path = decodeURIComponent(path);
    } catch {
        // keep the raw path
    }
    // /C:/Users/… → C:/Users/…
    if (/^\/[A-Za-z]:[\\/]/.test(path)) {
        path = path.slice(1);
    }
    return path;
}

function inferHomeDirectory(sessionRoot: string | null | undefined): string | null {
    if (!sessionRoot) {
        return null;
    }
    const normalizedRoot = normalizePath(sessionRoot);
    const match = normalizedRoot.match(/^([A-Za-z]:\/Users\/[^/]+|\/Users\/[^/]+|\/home\/[^/]+)/);
    return match?.[1] ?? null;
}

/**
 * ~/x → <home>/x when the home directory can be inferred from the session
 * root; null when it cannot. Leaving the tilde in place made resolvePath join
 * it to the project ("/srv/repo/~/file.ts", reported as inside the project,
 * #450) — an unresolvable reference is better left unlinked.
 */
function expandHomePath(value: string, sessionRoot: string | null | undefined): string | null {
    if (!/^~[\\/]/.test(value)) {
        return value;
    }
    const home = inferHomeDirectory(sessionRoot);
    if (!home) {
        return null;
    }
    return `${home}/${value.slice(2)}`;
}

function normalizePath(value: string): string {
    // UNC: keep the //server/share prefix intact (#452).
    const uncMatch = value.match(UNC_PATH);
    const withForwardSlashes = value.replace(/\\/g, '/');
    if (uncMatch) {
        const prefixLength = uncMatch[0].length;
        const uncPrefix = withForwardSlashes.slice(0, prefixLength);
        const tail = normalizePath(withForwardSlashes.slice(prefixLength).replace(/^\/+/, ''));
        return tail ? `${uncPrefix}/${tail}` : uncPrefix;
    }
    const isWindowsAbsolute = /^[A-Za-z]:\//.test(withForwardSlashes);
    const isPosixAbsolute = withForwardSlashes.startsWith('/');
    const prefix = isWindowsAbsolute ? `${withForwardSlashes.slice(0, 2)}/` : isPosixAbsolute ? '/' : '';
    const rawRemainder = isWindowsAbsolute ? withForwardSlashes.slice(3) : isPosixAbsolute ? withForwardSlashes.replace(/^\/+/, '') : withForwardSlashes;

    const parts = rawRemainder.split('/');
    const normalizedParts: string[] = [];

    for (const part of parts) {
        if (!part || part === '.') {
            continue;
        }
        if (part === '..') {
            if (normalizedParts.length > 0 && normalizedParts[normalizedParts.length - 1] !== '..') {
                normalizedParts.pop();
            } else if (!prefix) {
                normalizedParts.push(part);
            }
            continue;
        }
        normalizedParts.push(part);
    }

    if (!prefix) {
        return normalizedParts.join('/');
    }
    if (normalizedParts.length === 0) {
        return prefix;
    }
    return `${prefix}${normalizedParts.join('/')}`;
}

function isAbsolutePath(path: string): boolean {
    return WINDOWS_ABSOLUTE_PATH.test(path) || UNC_PATH.test(path) || POSIX_ABSOLUTE_PATH.test(path);
}

function resolvePath(path: string, sessionRoot: string | null | undefined): string | null {
    const decoded = decodeFileUrl(path);
    if (decoded === null) {
        return null;
    }
    const expandedPath = expandHomePath(decoded, sessionRoot);
    if (!expandedPath) {
        return null;
    }
    if (isAbsolutePath(expandedPath)) {
        return normalizePath(expandedPath);
    }
    if (!sessionRoot) {
        return null;
    }
    return normalizePath(`${normalizePath(sessionRoot)}/${expandedPath}`);
}

// "/" for a root of "/" (or "C:/"), "<root>/" otherwise — appending another
// separator to an already-terminated root made every child of a filesystem
// root register as outside the session (#448).
function rootPrefix(normalizedRoot: string): string {
    return normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;
}

function isWithinRoot(path: string, root: string | null | undefined): boolean {
    if (!root) {
        return false;
    }
    const normalizedPath = normalizePath(path);
    const normalizedRoot = normalizePath(root);
    return normalizedPath === normalizedRoot || normalizedPath.startsWith(rootPrefix(normalizedRoot));
}

function getRelativePath(path: string, root: string | null | undefined): string | null {
    if (!isWithinRoot(path, root) || !root) {
        return null;
    }
    const normalizedPath = normalizePath(path);
    const normalizedRoot = normalizePath(root);
    if (normalizedPath === normalizedRoot) {
        return '.';
    }
    return normalizedPath.slice(rootPrefix(normalizedRoot).length);
}

function looksLikeBareFileName(value: string): boolean {
    if (!BARE_FILE_NAME.test(value)) {
        return false;
    }
    const extension = value.split('.').pop() ?? '';
    return !NUMERIC_EXTENSION.test(extension);
}

function hasFileLikeEnding(value: string): boolean {
    const normalized = normalizePath(value);
    const basename = normalized.split('/').pop() ?? normalized;
    if (!basename) {
        return false;
    }
    if (EXTENSIONLESS_FILE_NAMES.has(basename)) {
        return true;
    }
    if (basename.startsWith('.')) {
        return basename.length > 1;
    }
    const lastDotIndex = basename.lastIndexOf('.');
    if (lastDotIndex <= 0 || lastDotIndex === basename.length - 1) {
        return false;
    }
    const extension = basename.slice(lastDotIndex + 1);
    if (!FILE_EXTENSION.test(extension)) {
        return false;
    }
    return !NUMERIC_EXTENSION.test(extension);
}

function isAppRoute(value: string): boolean {
    return APP_ROUTE_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function looksLikePath(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed) {
        return false;
    }
    if (WINDOWS_ABSOLUTE_PATH.test(trimmed) || UNC_PATH.test(trimmed)) {
        return true;
    }
    if (POSIX_ABSOLUTE_PATH.test(trimmed)) {
        return !isAppRoute(trimmed);
    }
    if (RELATIVE_PREFIX.test(trimmed)) {
        return true;
    }
    if (HAS_PATH_SEPARATOR.test(trimmed)) {
        return true;
    }
    return looksLikeBareFileName(trimmed);
}

// A token that unmistakably BEGINS a path reference of its own.
function hasPathPrefix(text: string): boolean {
    return WINDOWS_ABSOLUTE_PATH.test(text) || UNC_PATH.test(text)
        || text.startsWith('/') || text.startsWith('~/') || text.startsWith('./') || text.startsWith('../');
}

function buildLink(path: string, line: number | null, column: number | null, sessionRoot: string | null | undefined): SessionFileLink | null {
    const absolutePath = resolvePath(path, sessionRoot);
    if (!absolutePath) {
        return null;
    }
    return {
        // The reference as written, minus any file: URL wrapping (#449).
        path: normalizePath(decodeFileUrl(path) ?? path),
        absolutePath,
        relativePath: getRelativePath(absolutePath, sessionRoot),
        withinSessionRoot: isWithinRoot(absolutePath, sessionRoot),
        line,
        column,
    };
}

/**
 * Resolve a path the app ALREADY KNOWS is a file path (the viewer's decoded
 * `?path=` parameter, a git-status entry) against the session root. The path
 * is taken literally: `report:2026` is a file named `report:2026`, not line
 * 2026 of `report` (#163). Line and column travel as explicit route
 * parameters; only textual links (parseSessionFileLink) parse a `:line:col`
 * suffix, because there the suffix is the only place that information exists.
 */
export function resolveSessionFilePath(path: string, sessionRoot?: string | null): SessionFileLink | null {
    return buildLink(path.trim(), null, null, sessionRoot);
}

export function parseSessionFileLink(
    url: string,
    options?: { label?: string | null; sessionRoot?: string | null; bareText?: boolean }
): SessionFileLink | null {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
        return null;
    }

    const parsedUrl = parseLineAndColumn(trimmedUrl);
    const parsedLabel = options?.label ? parseLineAndColumn(options.label) : null;

    // Scheme check AFTER the line suffix is split off: "index.ts:12" is a
    // file with a line number, not an "index.ts:" scheme (#447). A real URL
    // ("https://…", "mailto:…") still has its colon in the path part. A
    // file: URL is a path, handled by decodeFileUrl.
    if (
        !WINDOWS_ABSOLUTE_PATH.test(parsedUrl.path)
        && !FILE_URL_PREFIX.test(parsedUrl.path)
        && URL_SCHEME.test(parsedUrl.path)
    ) {
        return null;
    }

    if (!looksLikePath(parsedUrl.path) && !looksLikePath(parsedLabel?.path ?? '')) {
        return null;
    }

    if (options?.bareText) {
        const hasStrongSignal =
            parsedUrl.line !== null ||
            parsedUrl.column !== null ||
            hasFileLikeEnding(parsedUrl.path);
        if (!hasStrongSignal) {
            return null;
        }
    }

    return buildLink(
        parsedUrl.path,
        parsedUrl.line ?? parsedLabel?.line ?? null,
        parsedUrl.column ?? parsedLabel?.column ?? null,
        options?.sessionRoot,
    );
}

type TokenMatch = {
    start: number;
    end: number;
    /** The token with its wrapping punctuation removed (computed once). */
    core: string;
};

function looksLikePathStart(text: string): boolean {
    if (!text) {
        return false;
    }
    if (hasPathPrefix(text)) {
        return true;
    }
    return HAS_PATH_SEPARATOR.test(text);
}

// A file path with spaces spans a few tokens at most; trying EVERY remaining
// span from every path-like token was cubic — 400 "a/ " tokens took ~1.8 s
// (#446). Candidates are capped in token count and never cross a line break,
// and the whole scan runs under a work budget (utils/parseBudget) whose
// exhaustion leaves the rest of the text plain rather than unrendered.
const MAX_PATH_SPAN_TOKENS = 8;

export function splitSessionFileText(text: string, sessionRoot?: string | null): SessionFileTextSegment[] {
    const segments: SessionFileTextSegment[] = [];
    if (exceedsInputBudget(text)) {
        segments.push({ text, link: null });
        return segments;
    }
    // ~4 µs per candidate parse: 20k candidates keeps the worst case under
    // ~100 ms; anything past that renders as plain text.
    const budget = parseBudget(20_000);
    const tokenPattern = /\S+/g;
    const tokens: TokenMatch[] = [];
    let match: RegExpExecArray | null;

    while ((match = tokenPattern.exec(text)) !== null) {
        tokens.push({ start: match.index, end: match.index + match[0].length, core: stripToken(match[0]).core });
    }

    let cursor = 0;
    let tokenIndex = 0;

    while (tokenIndex < tokens.length && !budget.exhausted) {
        const token = tokens[tokenIndex];

        if (!looksLikePathStart(token.core)) {
            tokenIndex += 1;
            continue;
        }

        let bestEnd = -1;
        let bestLink: SessionFileLink | null = null;
        let bestLeading = '';
        let bestCore = '';
        let bestTrailing = '';

        for (let candidateIndex = tokenIndex; candidateIndex < tokens.length; candidateIndex += 1) {
            if (candidateIndex - tokenIndex >= MAX_PATH_SPAN_TOKENS) break;
            if (candidateIndex > tokenIndex
                && text.slice(tokens[candidateIndex - 1].end, tokens[candidateIndex].start).includes('\n')) {
                break; // a path never continues on the next line
            }
            if (candidateIndex > tokenIndex) {
                // A span stops where a SEPARATE reference begins: "/repo/a.ts and
                // /repo/b.ts" used to link as one path "/repo/a.ts and /repo/b.ts"
                // because the longest file-like span won (#445). A token with an
                // absolute/relative prefix always starts a new reference; once
                // this span already names a file, any path-like token does
                // (a bare "notes.md", a "src/x.ts") — before that point such
                // tokens are the middle of a path with spaces
                // ("…/Application Support/CleanShot/…").
                const nextCore = tokens[candidateIndex].core;
                if (hasPathPrefix(nextCore)) break;
                if (bestLink && (HAS_PATH_SEPARATOR.test(nextCore) || looksLikeBareFileName(nextCore))) break;
            }
            if (!budget.spend()) break;
            const candidate = text.slice(token.start, tokens[candidateIndex].end);
            const stripped = stripToken(candidate);
            if (!stripped.core) {
                continue;
            }

            const link = parseSessionFileLink(stripped.core, {
                sessionRoot,
                bareText: true,
            });

            if (link) {
                bestEnd = candidateIndex;
                bestLink = link;
                bestLeading = stripped.leading;
                bestCore = stripped.core;
                bestTrailing = stripped.trailing;
            }
        }

        if (bestEnd === -1 || !bestLink) {
            tokenIndex += 1;
            continue;
        }

        const end = tokens[bestEnd].end;
        pushTextSegment(segments, text.slice(cursor, token.start));
        pushTextSegment(segments, bestLeading);
        segments.push({ text: bestCore, link: bestLink });
        pushTextSegment(segments, bestTrailing);
        cursor = end;
        tokenIndex = bestEnd + 1;
    }

    if (cursor < text.length) {
        pushTextSegment(segments, text.slice(cursor));
    }

    return segments;
}
