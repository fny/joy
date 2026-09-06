// Pure tokenizer for SimpleSyntaxHighlighter — NO react-native imports, so
// the adversarial-input timing tests run under node (vitest). The component
// in SimpleSyntaxHighlighter.tsx only maps these tokens to colours.

import { exceedsInputBudget, parseBudget } from '@/utils/parseBudget';

export type SyntaxToken = { text: string; type: string; nestLevel?: number };

// Bracket pairs for nesting detection
const bracketPairs = {
    '(': ')',
    '[': ']',
    '{': '}',
    '<': '>',
};

const openBrackets = Object.keys(bracketPairs);
const closeBrackets = Object.values(bracketPairs);

/** Code blocks longer than this render as plain monospace text (#241). */
export const HIGHLIGHT_INPUT_CAP = 100_000;

/** Total regex matches a single block may produce before the rest is plain. */
export const HIGHLIGHT_MATCH_BUDGET = 200_000;

// Enhanced tokenizer with comprehensive token types
export const tokenizeCode = (code: string, language: string | null): SyntaxToken[] => {
    const tokens: SyntaxToken[] = [];

    // Plain fallback: no language, or more text than anyone reads highlighted.
    // Tokenization runs synchronously during render, so its work MUST be
    // bounded by the input size (#241).
    if (!language || exceedsInputBudget(code, HIGHLIGHT_INPUT_CAP)) {
        return [{ text: code, type: 'default' }];
    }

    const lang = language.toLowerCase();

    // Language-specific keyword sets
    const keywordSets = {
        controlFlow: ['if', 'else', 'elif', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'return', 'yield', 'try', 'catch', 'finally', 'throw', 'with'],
        keywords: ['function', 'const', 'let', 'var', 'def', 'class', 'interface', 'enum', 'struct', 'union', 'namespace', 'module'],
        types: ['int', 'string', 'bool', 'float', 'double', 'char', 'void', 'any', 'unknown', 'never', 'object', 'array', 'number', 'boolean'],
        modifiers: ['public', 'private', 'protected', 'static', 'final', 'abstract', 'virtual', 'override', 'async', 'await', 'export', 'default'],
        boolean: ['true', 'false', 'null', 'undefined', 'None', 'True', 'False', 'nil'],
        imports: ['import', 'from', 'export', 'require', 'include', 'using', 'package'],
    };

    // Language-specific additions
    if (lang === 'python' || lang === 'py') {
        keywordSets.keywords.push('def', 'lambda', 'pass', 'global', 'nonlocal', 'as', 'in', 'is', 'not', 'and', 'or');
        keywordSets.types.push('str', 'list', 'dict', 'tuple', 'set');
    } else if (lang === 'typescript' || lang === 'ts') {
        keywordSets.types.push('Record', 'Partial', 'Required', 'Readonly', 'Pick', 'Omit');
        keywordSets.keywords.push('type', 'interface', 'extends', 'implements', 'keyof', 'typeof');
    } else if (lang === 'java') {
        keywordSets.keywords.push('package', 'extends', 'implements', 'super', 'this');
        keywordSets.modifiers.push('synchronized', 'transient', 'volatile', 'native', 'strictfp');
    }

    // Enhanced regex patterns for comprehensive tokenization
    const patterns: Array<{ regex: RegExp; type: string; captureGroup?: number }> = [
        // Comments (highest priority)
        { regex: /(\/\*[\s\S]*?\*\/)/g, type: 'comment' },
        { regex: /(\/\/.*$)/gm, type: 'comment' },
        { regex: /(#.*$)/gm, type: 'comment' },
        { regex: /("""[\s\S]*?"""|'''[\s\S]*?''')/g, type: 'docstring' },

        // Strings and regex
        { regex: /(r?["'`])((?:(?!\1)[^\\]|\\.)*)(\1)/g, type: 'string' },
        { regex: /(\/(?:[^\/\\\n]|\\.)+\/[gimuy]*)/g, type: 'regex' },

        // Numbers (including hex, binary, floats). The decimal part is ONE
        // unambiguous optional group: the old `\d+\.?\d*` had two adjacent
        // digit quantifiers, so a digit run that failed the trailing \b (e.g.
        // "…000a") backtracked quadratically — 64k digits took ~6 s (#241).
        { regex: /\b(0x[0-9a-fA-F]+|0b[01]+|0o[0-7]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/g, type: 'number' },

        // Decorators
        { regex: /@\w+/g, type: 'decorator' },

        // Function definitions and calls
        { regex: /\b(function|def|async function)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g, type: 'function', captureGroup: 2 },
        { regex: /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?=\()/g, type: 'function' },

        // Method calls (object.method)
        { regex: /\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?=\()/g, type: 'method', captureGroup: 1 },
        { regex: /\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g, type: 'property', captureGroup: 1 },

        // Keywords by category
        { regex: new RegExp(`\\b(${keywordSets.imports.join('|')})\\b`, 'g'), type: 'import' },
        { regex: new RegExp(`\\b(${keywordSets.controlFlow.join('|')})\\b`, 'g'), type: 'controlFlow' },
        { regex: new RegExp(`\\b(${keywordSets.keywords.join('|')})\\b`, 'g'), type: 'keyword' },
        { regex: new RegExp(`\\b(${keywordSets.types.join('|')})\\b`, 'g'), type: 'type' },
        { regex: new RegExp(`\\b(${keywordSets.modifiers.join('|')})\\b`, 'g'), type: 'modifier' },
        { regex: new RegExp(`\\b(${keywordSets.boolean.join('|')})\\b`, 'g'), type: 'boolean' },

        // Operators by category
        { regex: /(===|!==|==|!=|<=|>=|<|>)/g, type: 'comparison' },
        { regex: /(&&|\|\||!)/g, type: 'logical' },
        { regex: /(=|\+=|\-=|\*=|\/=|%=|\|=|&=|\^=)/g, type: 'assignment' },
        { regex: /(\+|\-|\*|\/|%|\*\*)/g, type: 'operator' },
        { regex: /(\?|:)/g, type: 'operator' },

        // Brackets and punctuation
        { regex: /([()[\]{}])/g, type: 'bracket' },
        { regex: /([.,;])/g, type: 'punctuation' },
    ];

    // Calculate bracket nesting levels
    const calculateBracketNesting = (code: string) => {
        const nestingMap = new Map<number, number>();
        const stack: Array<{ char: string; pos: number }> = [];

        for (let i = 0; i < code.length; i++) {
            const char = code[i];

            if (openBrackets.includes(char)) {
                stack.push({ char, pos: i });
                nestingMap.set(i, stack.length);
            } else if (closeBrackets.includes(char)) {
                if (stack.length > 0) {
                    const lastOpen = stack.pop();
                    if (lastOpen && bracketPairs[lastOpen.char as keyof typeof bracketPairs] === char) {
                        nestingMap.set(i, stack.length + 1);
                    }
                }
            }
        }

        return nestingMap;
    };

    const nestingMap = calculateBracketNesting(code);

    // One match budget for the whole block: once spent, the remaining lines
    // are emitted as plain text instead of being tokenized.
    const budget = parseBudget(HIGHLIGHT_MATCH_BUDGET);

    // Split code into lines to preserve line breaks
    const lines = code.split('\n');
    let globalOffset = 0;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        if (lineIndex > 0) {
            tokens.push({ text: '\n', type: 'default' });
            globalOffset += 1; // for the \n character
        }

        if (budget.exhausted) {
            if (line) tokens.push({ text: line, type: 'default' });
            globalOffset += line.length;
            continue;
        }

        const lineTokens: Array<{ start: number; end: number; type: string; text: string; captureGroup?: number }> = [];

        // Find all matches for all patterns
        for (const pattern of patterns) {
            let match: RegExpExecArray | null;
            pattern.regex.lastIndex = 0;
            while ((match = pattern.regex.exec(line)) !== null) {
                if (!budget.spend()) break;
                const tokenText = pattern.captureGroup ? match[pattern.captureGroup] : match[0];
                const tokenStart = pattern.captureGroup ? match.index + match[0].indexOf(tokenText) : match.index;

                lineTokens.push({
                    start: tokenStart,
                    end: tokenStart + tokenText.length,
                    type: pattern.type,
                    text: tokenText,
                    captureGroup: pattern.captureGroup,
                });
                // Guard against zero-length matches looping forever.
                if (match[0].length === 0) pattern.regex.lastIndex++;
            }
            if (budget.exhausted) break;
        }

        // Sort tokens by position and remove overlaps
        lineTokens.sort((a, b) => a.start - b.start);

        const filteredTokens: typeof lineTokens = [];
        let lastEnd = 0;
        lineTokens.forEach(token => {
            if (token.start >= lastEnd) {
                filteredTokens.push(token);
                lastEnd = token.end;
            }
        });

        // Add tokens with proper nesting levels for brackets
        let currentIndex = 0;
        filteredTokens.forEach(token => {
            // Add text before this token
            if (token.start > currentIndex) {
                const beforeText = line.slice(currentIndex, token.start);
                if (beforeText) {
                    tokens.push({ text: beforeText, type: 'default' });
                }
            }

            // Add the token with nesting level if it's a bracket
            if (token.type === 'bracket') {
                const globalPos = globalOffset + token.start;
                const nestLevel = nestingMap.get(globalPos) || 1;
                tokens.push({
                    text: token.text,
                    type: token.type,
                    nestLevel: nestLevel,
                });
            } else {
                tokens.push({ text: token.text, type: token.type });
            }

            currentIndex = token.end;
        });

        // Add remaining text
        if (currentIndex < line.length) {
            const remainingText = line.slice(currentIndex);
            if (remainingText) {
                tokens.push({ text: remainingText, type: 'default' });
            }
        }

        globalOffset += line.length;
    }

    return tokens;
};
