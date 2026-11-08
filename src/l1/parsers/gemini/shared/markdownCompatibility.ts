/**
 * Enforces the Compatibility Rule Admission Policy (Section 4 & 31):
 * - Initial state: empty (0 speculative rules).
 * - Every rule must have:
 *   - A unique rule ID (e.g. GM-MD-001, GM-TEX-001).
 *   - Provenance evidence pointing to a minimal real reproduction fixture.
 *   - Clear description explaining why standard parser behavior is insufficient for real Gemini.
 *   - Narrow deterministic transformation.
 */

import { inlineMathMarkdown } from '../../../../shared/utils/markdownMath.js';
import { LATEX_COMPAT_RULES } from '../../../../shared/utils/latexCompatibility.js';

function delimiterRun(source: string, start: number): string {
    let end = start + 1;
    while (source[end] === source[start]) end++;
    return source.slice(start, end);
}

interface CompatRuleMetadata {
    readonly id: string;
    readonly evidence: string;
    readonly observedAt: string;
    readonly description: string;
    readonly originalHash?: string;
}

interface MarkdownCompatRule extends CompatRuleMetadata {
    readonly domain: 'markdown';
    readonly transform: (source: string) => string;
}

interface TexCompatRule extends CompatRuleMetadata {
    readonly domain: 'tex';
    readonly transform: (source: string) => string;
}

export const GM_TEX_003_BAR_ALIASES: TexCompatRule = Object.freeze({
    id: 'GM-TEX-003', domain: 'tex',
    evidence: 'tests/fixtures/provider/math/gm_tex_003_evidence.json',
    observedAt: '2026-10-16T03:16:18Z',
    description: 'Native Gemini expands norm/absolute bar tokens to Vert{}/vert{} while raw Markdown retains escaped norm bars/raw absolute bars. Normalize only these exact aliases in parsed math; keep single and double bars distinct.',
    transform: (source: string): string => source.replace(/(\\+)(Vert|vert)\{\}/g, (literal, slashes: string, command: string) =>
        slashes.length % 2 === 0 ? literal : slashes.slice(0, -1) + (command === 'Vert' ? '\\|' : '|')),
});

export const normalizeGeminiTexAliases = GM_TEX_003_BAR_ALIASES.transform;

/** Contextual MDAST adaptation, rather than source rewriting. */
export const GM_MD_004_LINE_START_DISPLAY = Object.freeze({
    id: 'GM-MD-004', domain: 'markdown',
    evidence: 'tests/fixtures/provider/math/gm_md_004_evidence.md',
    observedAt: '2026-10-16T03:16:18Z',
    description: 'Live Gemini renders a $$ formula on its own line as a separate display block even without a blank line before it. Split its parsed paragraph, retaining preceding/following prose and list ownership; delimiters sharing a line with prose stay inline.',
});

/**
 * Standard micromark mathFlow requires standalone $$ delimiters to open and close fences.
 */
function normalizeMathFences(source: string): string {
    if (!source || !source.includes('$$')) return source;

    const lines = source.split('\n');
    let inCodeBlock = false;
    let codeFence = '';
    let inDisplayMath = false;
    const result: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trimStart();

        // Track code blocks (``` or ~~~) so math delimiters inside code are left untouched
        if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
            const fence = trimmed.slice(0, 3);
            if (!inCodeBlock) {
                inCodeBlock = true;
                codeFence = fence;
            } else if (trimmed.startsWith(codeFence)) {
                inCodeBlock = false;
                codeFence = '';
            }
            result.push(line);
            continue;
        }

        if (inCodeBlock) {
            result.push(line);
            continue;
        }

        const prefixMatch = line.match(/^([ \t]*(?:>[ \t]*)*)(.*)$/);
        const prefix = prefixMatch ? prefixMatch[1] : '';
        const rest = prefixMatch ? prefixMatch[2] : line;
        const restTrimmed = rest.trim();

        if (!inDisplayMath) {
            if (restTrimmed === '$$') {
                inDisplayMath = true;
                result.push(line);
                continue;
            }

            if (rest.startsWith('$$') && !rest.slice(2).trimStart().startsWith('$')) {
                const restAfterOpen = rest.slice(2);
                if (!restAfterOpen.includes('$$')) {
                    result.push(prefix + '$$');
                    result.push(prefix + restAfterOpen);
                    inDisplayMath = true;
                    continue;
                }
            }

            result.push(line);
        } else {
            if (restTrimmed === '$$') {
                inDisplayMath = false;
                result.push(line);
                continue;
            }

            if (restTrimmed.endsWith('$$') && !restTrimmed.slice(0, -2).trimEnd().endsWith('$')) {
                const restBeforeClose = restTrimmed.slice(0, -2);
                if (!restBeforeClose.includes('$$')) {
                    result.push(prefix + restBeforeClose);
                    result.push(prefix + '$$');
                    inDisplayMath = false;
                    continue;
                }
            }

            result.push(line);
        }
    }

    return result.join('\n');
}

export const GM_MD_001_FENCE_NORMALIZATION: MarkdownCompatRule = Object.freeze({
    id: 'GM-MD-001',
    domain: 'markdown',
    evidence: 'tests/fixtures/provider/math/gm_md_001_evidence.md',
    observedAt: '2026-09-29T23:50:00Z',
    description:
        'Normalizes multiline display-math fences ($$) where LaTeX environment keywords ' +
        '(e.g. \\begin{aligned}, \\end{aligned}) are attached directly to $$ on the fence line, ' +
        'ensuring standard GFM/micromark mathFlow fences open and close deterministically ' +
        'without swallowing subsequent document blocks.',
    transform: normalizeMathFences,
});

/**
 * Initial state was empty; GM-MD-001 admitted per Section 4 & 31 admission policy.
 */
/** Real Gemini emits raw absolute-value bars inside table math, before GFM lexing. */
export function normalizeTableMathPipes(source: string): string {
    const lines = source.split('\n');
    const pipeCount = (line: string): number => {
        let count = 0;
        for (let i = 0; i < line.length; i++) if (line[i] === '|') {
            let slashes = 0; for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) slashes++;
            if (slashes % 2 === 0) count++;
        }
        return count;
    };
    const mathPipes = (line: string): string => {
        let code = ''; let result = ''; let offset = 0;
        for (let i = 0; i < line.length; i++) {
            if (line[i] === '\\') { i++; continue; }
            if (line[i] === '`') {
                const run = delimiterRun(line, i);
                if (!code) code = run; else if (code === run) code = '';
                i += run.length - 1; continue;
            }
            if (code || line[i] !== '$' || line[i + 1] === '$') continue;
            let end = i + 1;
            for (; end < line.length; end++) {
                if (line[end] === '\\') { end++; continue; }
                if (line[end] === '$') break;
            }
            const content = line.slice(i + 1, end);
            if (end >= line.length || line[end + 1] === '$' || content !== content.trim()) continue;
            const fixed = content.replace(/(\\*)\|/g, (match, slashes: string) => slashes.length % 2 === 0 ? slashes + '\\vert{}' : match);
            result += line.slice(offset, i + 1) + fixed + '$'; offset = end + 1; i = end;
        }
        return result + line.slice(offset);
    };
    let fence = ''; let width: number | null = null;
    for (let i = 0; i < lines.length; i++) {
        const marker = /^\s*(`{3,}|~{3,})/.exec(lines[i])?.[1];
        if (marker) {
            if (!fence) fence = marker;
            else if (marker[0] === fence[0] && marker.length >= fence.length) fence = '';
            width = null; continue;
        }
        if (fence) continue;
        if (/^\s*\|\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|\s*$/.test(lines[i]) && i > 0) {
            const count = pipeCount(lines[i]); const header = mathPipes(lines[i - 1]);
            if (/^\s*\|.*\|\s*$/.test(header) && pipeCount(header) === count) { lines[i - 1] = header; width = count; }
            else width = null;
            continue;
        }
        if (width !== null && /^\s*\|.*\|\s*$/.test(lines[i])) {
            const row = mathPipes(lines[i]);
            if (pipeCount(row) === width) lines[i] = row;
        } else width = null;
    }
    return lines.join('\n');
}

const GM_MD_002_TABLE_MATH_PIPES: MarkdownCompatRule = Object.freeze({
    id: 'GM-MD-002', domain: 'markdown',
    evidence: 'tests/fixtures/provider/math/gm_md_002_evidence.md',
    observedAt: '2026-10-11T17:31:25Z',
    description: 'Live oblique-shock report used unescaped absolute-value bars inside table math. GFM split the header into extra columns and lost the table. Replace only math bars in rows whose resulting column count matches the physical delimiter row.',
    transform: normalizeTableMathPipes,
});

/** Gemini treats a backslash-dollar inside a formula as source, unlike micromark. */
export function normalizeEscapedDollarMath(source: string): string {
    if (!/\\\$/.test(source)) return source;
    const protectedRanges = new Map<number, number>();
    let offset = 0, fence = '', displayMath = false;
    for (const line of source.split(/(?<=\n)/)) {
        const marker = /^ {0,3}(?:> ?)*(`{3,}|~{3,})/.exec(line)?.[1];
        const display = /^ {0,3}(?:> ?)*\$\$[ \t]*(?:\r?\n)?$/.test(line);
        if (fence || marker || displayMath || display || /^(?: {4}|\t)/.test(line)) {
            protectedRanges.set(offset, offset + line.length);
        }
        if (marker) {
            if (!fence) fence = marker;
            else if (marker[0] === fence[0] && marker.length >= fence.length) fence = '';
        }
        if (!fence && display) displayMath = !displayMath;
        offset += line.length;
    }
    let result = '';
    for (let i = 0; i < source.length;) {
        const protectedEnd = protectedRanges.get(i);
        if (protectedEnd !== undefined) { result += source.slice(i, protectedEnd); i = protectedEnd; continue; }
        if (source[i] === '`') {
            const run = delimiterRun(source, i);
            let end = i + run.length;
            while ((end = source.indexOf(run, end)) >= 0) {
                if (source[end - 1] !== '`' && source[end + run.length] !== '`') break;
                end += run.length;
            }
            if (end >= 0) { result += source.slice(i, end + run.length); i = end + run.length; continue; }
        }
        if (source[i] === '$' && source[i + 1] === '$') {
            const run = delimiterRun(source, i);
            const end = source.indexOf(run, i + run.length);
            if (end >= 0) { result += source.slice(i, end + run.length); i = end + run.length; continue; }
        }
        if (source[i] !== '$' || source[i - 1] === '\\' || source[i - 1] === '$' || source[i + 1] === '$') {
            result += source[i++]; continue;
        }
        let end = i + 1, escapedDollar = false;
        while (end < source.length && source[end] !== '\n' && !protectedRanges.has(end)) {
            if (source[end] === '\\') {
                while (source[end] === '\\') end++;
                if (source[end] === '$') { escapedDollar = true; end++; }
            } else if (source[end] === '$') break;
            else end++;
        }
        if (escapedDollar && source[end] === '$' && source[end + 1] !== '$') {
            result += inlineMathMarkdown(source.slice(i + 1, end)); i = end + 1;
        } else result += source[i++];
    }
    return result;
}

const GM_MD_003_ESCAPED_DOLLAR_MATH: MarkdownCompatRule = Object.freeze({
    id: 'GM-MD-003', domain: 'markdown',
    evidence: 'tests/fixtures/provider/math/gm_md_003_evidence.md',
    observedAt: '2026-10-15T19:07:00Z',
    description: 'Live arithmetic-coding answer renders escaped dollar symbols inside three inline formulas. Use longer padded math delimiters without changing their TeX source; exclude code and existing display math.',
    transform: normalizeEscapedDollarMath,
});

export const GEMINI_MARKDOWN_COMPAT_RULES: readonly MarkdownCompatRule[] = Object.freeze([
    GM_MD_001_FENCE_NORMALIZATION,
    GM_MD_002_TABLE_MATH_PIPES,
    GM_MD_003_ESCAPED_DOLLAR_MATH,
]);

/**
 * When GEMINI_MARKDOWN_COMPAT_RULES is empty, this is an exact identity no-op.
 */
export function preprocessGeminiMarkdown(source: string): string {
    if (!GEMINI_MARKDOWN_COMPAT_RULES.length) return source;
    let result = source;
    for (const rule of GEMINI_MARKDOWN_COMPAT_RULES) {
        result = rule.transform(result);
    }
    return result;
}


export { preprocessLatex as preprocessGeminiLatex } from '../../../../shared/utils/latexCompatibility.js';
export const GEMINI_TEX_COMPAT_RULES: readonly TexCompatRule[] = Object.freeze([...LATEX_COMPAT_RULES, GM_TEX_003_BAR_ALIASES]);
