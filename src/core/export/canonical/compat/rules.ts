/**
 * src/core/export/canonical/compat/rules.ts
 *
 * Gemini Exporter - Parser Compatibility Rule Registry
 *
 * Enforces the Compatibility Rule Admission Policy (Section 4 & 31):
 * - Initial state: empty (0 speculative rules).
 * - Every rule must have:
 *   - A unique rule ID (e.g. GM-MD-001, GM-TEX-001).
 *   - Provenance evidence pointing to a minimal real reproduction fixture.
 *   - Clear description explaining why standard parser behavior is insufficient for real Gemini.
 *   - Narrow deterministic transformation.
 */

export interface CompatRuleMetadata {
    /** Unique rule identifier, e.g. 'GM-MD-001' or 'GM-TEX-001' */
    readonly id: string;
    /** Relative path to minimal reproduction test fixture with real provenance */
    readonly evidence: string;
    /** Timestamp when this behavior was first observed on live Gemini */
    readonly observedAt: string;
    /** Concise explanation of why standard parser is insufficient */
    readonly description: string;
    /** Hash or fingerprint of the original minimal trigger input */
    readonly originalHash?: string;
}

export interface MarkdownCompatRule extends CompatRuleMetadata {
    readonly domain: 'markdown';
    readonly transform: (source: string) => string;
}

export interface TexCompatRule extends CompatRuleMetadata {
    readonly domain: 'tex';
    readonly transform: (source: string) => string;
}

/**
 * Normalizes multiline display-math fences ($$) where LaTeX environment keywords
 * (e.g. \\begin{aligned}, \\end{aligned}) are attached directly to $$ on the fence line.
 * Standard micromark mathFlow requires standalone $$ delimiters to open and close fences.
 */
export function normalizeMathFences(source: string): string {
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

        // Match lines with optional blockquote prefix or indentation
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

            // Check if line starts with $$ followed by content, but does NOT contain another $$ on the same line
            // e.g. "$$\begin{aligned}" -> opening multiline display math fence with attached content.
            // If rest contains another $$ (e.g. "$$x^2$$" or "$$x^2$$ text" or "$$a$$ and $$b$$"), it is self-contained on this line.
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
            // Already inside multiline display math block
            if (restTrimmed === '$$') {
                inDisplayMath = false;
                result.push(line);
                continue;
            }

            // Check if line ends with $$ attached to math content (e.g. "\end{aligned}$$")
            // Ensure this line does not contain an opening $$ earlier on the same line
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
    evidence: 'tests/fixtures/canonical/math/gm_md_001_evidence.md',
    observedAt: '2026-09-29T23:50:00Z',
    description:
        'Normalizes multiline display-math fences ($$) where LaTeX environment keywords ' +
        '(e.g. \\begin{aligned}, \\end{aligned}) are attached directly to $$ on the fence line, ' +
        'ensuring standard GFM/micromark mathFlow fences open and close deterministically ' +
        'without swallowing subsequent document blocks.',
    transform: normalizeMathFences,
});

/**
 * Active Markdown compatibility rules.
 * Initial state was empty; GM-MD-001 admitted per Section 4 & 31 admission policy.
 */
export const GEMINI_MARKDOWN_COMPAT_RULES: readonly MarkdownCompatRule[] = Object.freeze([
    GM_MD_001_FENCE_NORMALIZATION,
]);

export const GM_TEX_001_SCR_NORMALIZATION: TexCompatRule = Object.freeze({
    id: 'GM-TEX-001',
    domain: 'tex',
    evidence: 'tests/fixtures/canonical/math/gm_tex_001_evidence.tex',
    observedAt: '2026-10-01T18:00:00Z',
    description:
        'Normalizes \\mathscr to \\mathcal since Gemini frequently outputs standard physics ' +
        'script symbols (e.g. Bondi-Sachs Scri \\mathscr{I}) which MiTeX does not recognize in its base dictionary.',
    transform: (source: string) => source.replace(/\\mathscr(?![a-zA-Z])/g, '\\mathcal'),
});

/**
 * Active LaTeX compatibility rules.
 * Admitted per Section 4 & 31 admission policy with physical evidence fixture.
 */
export const GEMINI_TEX_COMPAT_RULES: readonly TexCompatRule[] = Object.freeze([
    GM_TEX_001_SCR_NORMALIZATION,
]);

/**
 * Preprocesses raw Gemini Markdown through registered compatibility rules.
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

/**
 * Preprocesses raw Gemini LaTeX through registered compatibility rules.
 * When GEMINI_TEX_COMPAT_RULES is empty, this is an exact identity no-op.
 */
export function preprocessGeminiLatex(source: string): string {
    if (!GEMINI_TEX_COMPAT_RULES.length) return source;
    let result = source;
    for (const rule of GEMINI_TEX_COMPAT_RULES) {
        result = rule.transform(result);
    }
    return result;
}
