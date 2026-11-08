/** Evidence-backed notation adaptation for the MiTeX engine. */
interface LatexCompatRule {
    readonly id: string;
    readonly domain: 'tex';
    readonly evidence: string;
    readonly observedAt: string;
    readonly description: string;
    readonly originalHash?: string;
    readonly transform: (source: string) => string;
}
const MATHSCR_COMPAT_RULE: LatexCompatRule = Object.freeze({
    id: 'GM-TEX-001',
    domain: 'tex',
    evidence: 'tests/fixtures/provider/math/gm_tex_001_evidence.tex',
    observedAt: '2026-10-01T18:00:00Z',
    description:
        'Normalizes \\mathscr to \\mathcal since Gemini frequently outputs standard physics ' +
        'script symbols (e.g. Bondi-Sachs Scri \\mathscr{I}) which MiTeX does not recognize in its base dictionary.',
    transform: (source: string) => source.replace(/\\mathscr(?![a-zA-Z])/g, '\\mathcal'),
});

/** Escape literal underscores only in flat TeX text arguments, never math subscripts. */
export function normalizeTextUnderscores(source: string): string {
    return source.replace(/(\\+)text\{([^{}]*)\}/g, (match, slashes: string, body: string) =>
        slashes.length % 2 === 0 ? match : slashes + 'text{' + body.replace(/(\\*)_/g,
            (token, escapes: string) => escapes.length % 2 ? token : escapes + '\\_') + '}');
}

const TEXT_UNDERSCORE_COMPAT_RULE: LatexCompatRule = Object.freeze({
    id: 'GM-TEX-002', domain: 'tex',
    evidence: 'tests/fixtures/provider/math/gm_tex_002_evidence.tex',
    observedAt: '2026-10-15T19:58:00Z',
    description: 'Live arithmetic-coding RPC emits \\text{run_length}, while Gemini displays \\text{run\\_length}. Escape bare underscores in flat text arguments so KaTeX renders the same literal identifier instead of failing.',
    transform: normalizeTextUnderscores,
});

/** Standard centered negation of implication, observed in live vector-clock replies. */
export const CENTERED_NOT_IMPLIES_COMPAT_RULE: LatexCompatRule = Object.freeze({
    id: 'GM-TEX-004', domain: 'tex',
    evidence: 'tests/fixtures/provider/math/gm_tex_004_evidence.tex',
    observedAt: '2026-10-20T23:00:00Z',
    description: 'Live vector-clock replies use \\centernot\\implies. MiTeX lacks the centernot package; the standard \\nRightarrow relation preserves its negated-implication semantics.',
    transform: (source: string) => source.replace(/(\\+)centernot\s*\\implies(?![a-zA-Z])/g,
        (raw, slashes: string) => slashes.length % 2 ? slashes.slice(1) + '\\nRightarrow' : raw),
});

/**
 * Active LaTeX compatibility rules.
 * Admitted per Section 4 & 31 admission policy with physical evidence fixture.
 */
export const LATEX_COMPAT_RULES: readonly LatexCompatRule[] = Object.freeze([
    MATHSCR_COMPAT_RULE,
    TEXT_UNDERSCORE_COMPAT_RULE,
    CENTERED_NOT_IMPLIES_COMPAT_RULE,
]);

export function preprocessLatex(source: string): string {
    if (!LATEX_COMPAT_RULES.length) return source;
    let result = source;
    for (const rule of LATEX_COMPAT_RULES) {
        result = rule.transform(result);
    }
    return result;
}
