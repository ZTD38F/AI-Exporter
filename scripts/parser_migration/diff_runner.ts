/**
 * scripts/parser_migration/diff_runner.ts
 *
 * Legacy vs New Parser Differential Runner (Section 8.4, 22 & Remediation 1.1)
 *
 * CORE INVARIANTS:
 * 1. Default-Semantic Principle:
 *    The comparator performs recursive deep comparison over the entire Canonical AST.
 *    Only explicit ephemeral metadata (id) is ignored.
 *    Any other field (known or future unknown) is default-semantic and will trigger a diff.
 * 2. Minimal Explicit Canonicalization:
 *    - Undefined and absent keys are equivalent.
 *    - Adjacent inline text nodes are coalesced.
 *    - Code block languages are trimmed and lowercased.
 * 3. The old parser is NOT an oracle:
 *    All differences default to 'D_CANNOT_DETERMINE'. No manual category override is permitted.
 */

export type DiffCategory =
    | 'A_NEW_PARSER_CORRECT'
    | 'B_OLD_PARSER_GEMINI_DIALECT'
    | 'C_BOTH_REASONABLE'
    | 'D_CANNOT_DETERMINE';

export type DiffRationaleKind =
    | 'IDENTICAL'
    | 'FORMATTING_LOST'
    | 'LINK_CORRUPTED'
    | 'MATH_CORRUPTED'
    | 'TABLE_DIVERGENCE'
    | 'STRUCTURE_DIVERGENCE'
    | 'CONTENT_CHANGED'
    | 'UNKNOWN_FALLBACK_DIVERGENCE';

export interface BlockSummary {
    type: string;
    textLength: number;
    childCount: number;
    preview: string;
}

export interface AstSemanticFingerprint {
    blockCount: number;
    blockTypes: string[];
    blocks: BlockSummary[];
    totalTextLength: number;
}

export interface SemanticDiffResult {
    domain: 'markdown' | 'latex';
    inputPreview: string;
    hasDiff: boolean;
    category?: DiffCategory;
    rationaleKind?: DiffRationaleKind;
    rationale?: string;
    candidateConversionGain?: boolean;
    baseline: any;
    candidate: any;
}

/** Ephemeral execution/provenance metadata ignored during semantic AST comparison */
const EPHEMERAL_FIELDS = new Set(['id']);

/**
 * Coalesces adjacent text nodes in an inline list without modifying original nodes.
 */
function coalesceInlines(nodes: any[]): any[] {
    const result: any[] = [];
    for (const node of nodes) {
        if (!node) continue;
        if (node.type === 'text') {
            const last = result[result.length - 1];
            if (last && last.type === 'text') {
                result[result.length - 1] = {
                    ...last,
                    text: (last.text || '') + (node.text || ''),
                };
                continue;
            }
        }
        result.push(node);
    }
    return result;
}

/**
 * Normalizes an AST value by stripping only explicit ephemeral metadata and
 * applying minimal equivalence rules.
 */
export function canonicalizeSemanticAst(val: any): any {
    if (val === null || val === undefined || typeof val !== 'object') {
        return val;
    }

    if (Array.isArray(val)) {
        // If this array contains inline text nodes, coalesce adjacent text
        const isInlineArray = val.some((item) => item && typeof item === 'object' && item.type === 'text');
        const list = isInlineArray ? coalesceInlines(val) : val;
        return list.map(canonicalizeSemanticAst);
    }

    const cleaned: Record<string, any> = {};
    const keys = Object.keys(val).sort();

    for (const key of keys) {
        if (EPHEMERAL_FIELDS.has(key)) {
            continue;
        }
        const v = val[key];
        if (v === undefined) {
            continue; // undefined is equivalent to absent key
        }

        // Minimal canonicalization for code block language
        if (key === 'language' && typeof v === 'string' && val.type === 'code') {
            cleaned[key] = v.trim().toLowerCase();
        } else {
            cleaned[key] = canonicalizeSemanticAst(v);
        }
    }

    return cleaned;
}

interface DiffDetail {
    path: string;
    kind: DiffRationaleKind;
    message: string;
}

/**
 * Deeply compares two canonicalized AST structures and detects the first discrepancy.
 */
function deepCompareAst(path: string, a: any, b: any): DiffDetail | null {
    if (a === b) return null;

    if (a === null || a === undefined || b === null || b === undefined) {
        return {
            path,
            kind: 'STRUCTURE_DIVERGENCE',
            message: `${path}: value mismatch (${JSON.stringify(a)} vs ${JSON.stringify(b)})`,
        };
    }

    if (typeof a !== typeof b) {
        return {
            path,
            kind: 'STRUCTURE_DIVERGENCE',
            message: `${path}: type mismatch (${typeof a} vs ${typeof b})`,
        };
    }

    if (typeof a !== 'object') {
        return {
            path,
            kind: 'CONTENT_CHANGED',
            message: `${path}: primitive mismatch (${JSON.stringify(a)} vs ${JSON.stringify(b)})`,
        };
    }

    if (Array.isArray(a) !== Array.isArray(b)) {
        return {
            path,
            kind: 'STRUCTURE_DIVERGENCE',
            message: `${path}: array/object mismatch`,
        };
    }

    if (Array.isArray(a)) {
        if (a.length !== b.length) {
            return {
                path,
                kind: 'STRUCTURE_DIVERGENCE',
                message: `${path}: array length mismatch (${a.length} vs ${b.length})`,
            };
        }
        for (let i = 0; i < a.length; i++) {
            const itemDiff = deepCompareAst(`${path}[${i}]`, a[i], b[i]);
            if (itemDiff) return itemDiff;
        }
        return null;
    }

    // Both are objects
    const aType = a.type;
    const bType = b.type;
    if (aType && bType && aType !== bType) {
        if ((aType === 'strong' || aType === 'emphasis') && bType === 'text') {
            return {
                path,
                kind: 'FORMATTING_LOST',
                message: `${path}: formatting '${aType}' was lost to plain text in candidate`,
            };
        }
        if (aType === 'text' && (bType === 'strong' || bType === 'emphasis')) {
            return {
                path,
                kind: 'FORMATTING_LOST',
                message: `${path}: candidate introduced formatting '${bType}' where baseline had plain text`,
            };
        }
        if (aType === 'link' || bType === 'link') {
            return {
                path,
                kind: 'LINK_CORRUPTED',
                message: `${path}: link node mismatch ('${aType}' vs '${bType}')`,
            };
        }
        if (aType === 'math' || aType === 'inlineMath' || bType === 'math' || bType === 'inlineMath') {
            return {
                path,
                kind: 'MATH_CORRUPTED',
                message: `${path}: math node mismatch ('${aType}' vs '${bType}')`,
            };
        }
        if (aType === 'table' || bType === 'table') {
            return {
                path,
                kind: 'TABLE_DIVERGENCE',
                message: `${path}: table node mismatch ('${aType}' vs '${bType}')`,
            };
        }
        return {
            path,
            kind: 'STRUCTURE_DIVERGENCE',
            message: `${path}: node type mismatch ('${aType}' vs '${bType}')`,
        };
    }

    const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of allKeys) {
        if (EPHEMERAL_FIELDS.has(key)) continue;

        const valA = a[key];
        const valB = b[key];

        // undefined is equivalent to absent
        if (valA === undefined && valB === undefined) continue;

        const subDiff = deepCompareAst(`${path}.${key}`, valA, valB);
        if (subDiff) {
            // Refine kind based on key
            if (key === 'href' || aType === 'link') {
                return { ...subDiff, kind: 'LINK_CORRUPTED' };
            }
            if (key === 'source' || aType === 'math' || aType === 'inlineMath') {
                return { ...subDiff, kind: 'MATH_CORRUPTED' };
            }
            if (aType === 'table' || key === 'columns' || key === 'headerRows' || key === 'rows') {
                return { ...subDiff, kind: 'TABLE_DIVERGENCE' };
            }
            if (key === 'text' || key === 'code') {
                return { ...subDiff, kind: 'CONTENT_CHANGED' };
            }
            return subDiff;
        }
    }

    return null;
}

/**
 * Recursively extracts human-readable text from an AST node for fingerprinting.
 */
function extractText(node: any): string {
    if (!node) return '';
    if (typeof node === 'string') return node;
    if (node.text) return node.text;
    if (node.code) return node.code;
    if (node.source) return node.source;
    if (Array.isArray(node.children)) {
        return node.children.map(extractText).join('');
    }
    if (Array.isArray(node.items)) {
        return node.items.map((it: any) => (it.blocks || []).map(extractText).join('')).join('');
    }
    if (Array.isArray(node.blocks)) {
        return node.blocks.map(extractText).join('');
    }
    if (Array.isArray(node.rows)) {
        return node.rows.map((r: any) => (r.cells || []).map(extractText).join('\t')).join('\n');
    }
    return '';
}

/**
 * Extracts a simplified semantic fingerprint of a canonical AST message.
 */
export function extractAstFingerprint(bundle: any): AstSemanticFingerprint {
    const msg = bundle?.conversation?.messages?.[0];
    const blocks: any[] = msg?.blocks || [];

    const summaries: BlockSummary[] = blocks.map((b) => {
        const text = extractText(b);
        let childCount = 0;
        if (Array.isArray(b.children)) childCount = b.children.length;
        else if (Array.isArray(b.items)) childCount = b.items.length;
        else if (Array.isArray(b.blocks)) childCount = b.blocks.length;
        else if (Array.isArray(b.rows)) childCount = b.rows.length;

        return {
            type: b.type,
            textLength: text.length,
            childCount,
            preview: text.slice(0, 60),
        };
    });

    const totalText = summaries.reduce((acc, curr) => acc + curr.textLength, 0);

    return {
        blockCount: blocks.length,
        blockTypes: blocks.map((b) => b.type),
        blocks: summaries,
        totalTextLength: totalText,
    };
}

/**
 * Compares two Markdown normalization results semantically via default-semantic deep comparison.
 * Invariant: Defaults all diffs to 'D_CANNOT_DETERMINE'.
 * Old parser is NEVER assumed correct.
 */
export function compareMarkdownAst(
    input: string,
    baselineBundle: any,
    candidateBundle: any,
): SemanticDiffResult {
    const baseFp = extractAstFingerprint(baselineBundle);
    const candFp = extractAstFingerprint(candidateBundle);

    const baseBlocks: any[] = baselineBundle?.conversation?.messages?.[0]?.blocks || [];
    const candBlocks: any[] = candidateBundle?.conversation?.messages?.[0]?.blocks || [];

    const canonicalBase = baseBlocks.map(canonicalizeSemanticAst);
    const canonicalCand = candBlocks.map(canonicalizeSemanticAst);

    const diff = deepCompareAst('root', canonicalBase, canonicalCand);

    if (!diff) {
        return {
            domain: 'markdown',
            inputPreview: input.slice(0, 80),
            hasDiff: false,
            rationaleKind: 'IDENTICAL',
            baseline: baseFp,
            candidate: candFp,
        };
    }

    return {
        domain: 'markdown',
        inputPreview: input.slice(0, 80),
        hasDiff: true,
        category: 'D_CANNOT_DETERMINE',
        rationaleKind: diff.kind,
        rationale: `[${diff.kind}] ${diff.message}. Old parser is not an oracle; requires standard validation or verified raw Gemini evidence to reclassify.`,
        baseline: baseFp,
        candidate: candFp,
    };
}

/**
 * Compares two LaTeX math conversion results semantically.
 * Defaults diffs to 'D_CANNOT_DETERMINE'.
 */
export function compareMathConversion(
    latex: string,
    baselineResult: { typst?: string; diagnostic?: any },
    candidateResult: { typst?: string; diagnostic?: any },
): SemanticDiffResult {
    const hasDiff =
        baselineResult.typst !== candidateResult.typst ||
        !!baselineResult.diagnostic !== !!candidateResult.diagnostic;

    if (!hasDiff) {
        return {
            domain: 'latex',
            inputPreview: latex.slice(0, 80),
            hasDiff: false,
            rationaleKind: 'IDENTICAL',
            baseline: baselineResult,
            candidate: candidateResult,
        };
    }

    const candidateConversionGain = !baselineResult.typst && !!candidateResult.typst;

    return {
        domain: 'latex',
        inputPreview: latex.slice(0, 80),
        hasDiff: true,
        category: 'D_CANNOT_DETERMINE',
        candidateConversionGain,
        rationaleKind: candidateConversionGain ? 'IDENTICAL' : 'MATH_CORRUPTED',
        rationale: candidateConversionGain
            ? 'Candidate converted LaTeX expression where baseline fell back. Diff defaults to D_CANNOT_DETERMINE until verified against LaTeX/MiTeX standards or project policy.'
            : 'Math conversion divergence detected. Old converter is not an oracle; requires MiTeX standard verification or raw Gemini evidence.',
        baseline: baselineResult,
        candidate: candidateResult,
    };
}
