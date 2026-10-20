/**
 * src/core/export/typst/mitex/mitexConverter.ts
 *
 * Controlled LaTeX -> Typst math converter backed by MiTeX WASM engine.
 * Conforms to TeX Migration Gate requirements (Plan Section 28):
 * - Fail-closed: Never crashes on malformed LaTeX; catches errors, emits TYPST_MATH_CONVERT_FAILED, preserves raw LaTeX.
 * - Standard semantics: Preserves MiTeX upstream LaTeX authority with zero speculative compatibility rules.
 */

import type { RenderDiagnostic } from '../../canonical/rendering.js';
import { preprocessGeminiLatex } from '../../canonical/compat/rules.js';
import { mitexConvertMath } from './mitexLoader.js';

export interface MathConversionResult {
    typst?: string;
    diagnostic?: RenderDiagnostic;
}

function preview(source: string, max = 80): string {
    const flat = source.replace(/\s+/g, ' ');
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function warn(code: string, message: string): RenderDiagnostic {
    return { severity: 'warning', code, message };
}

export function convertMathWithMitex(
    source: string,
    notationOrDisplay?: string | boolean,
    maybeDisplay?: boolean,
): MathConversionResult {
    let notation = 'latex';
    let display = false;

    if (typeof notationOrDisplay === 'boolean') {
        display = notationOrDisplay;
    } else if (typeof notationOrDisplay === 'string') {
        notation = notationOrDisplay;
        display = maybeDisplay ?? false;
    }

    if (notation !== 'latex') {
        return {
            diagnostic: warn(
                'TYPST_MATH_UNSUPPORTED_NOTATION',
                `Math notation '${notation}' is not supported by the controlled converter (only 'latex'); raw source preserved.`,
            ),
        };
    }

    if (typeof source !== 'string' || source.trim() === '') {
        return {
            diagnostic: warn(
                'TYPST_MATH_EMPTY',
                'Empty math source cannot be converted; raw source preserved.',
            ),
        };
    }

    try {
        const preprocessed = preprocessGeminiLatex(source);
        const typst = mitexConvertMath(preprocessed);

        if (!typst || typst.trim() === '') {
            return {
                diagnostic: warn(
                    'TYPST_MATH_EMPTY',
                    'Math source produced no convertible content; raw source preserved.',
                ),
            };
        }

        return { typst };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
            diagnostic: warn(
                'TYPST_MATH_CONVERT_FAILED',
                `LaTeX math could not be converted to Typst (${reason}); raw source preserved: ${preview(source)}`,
            ),
        };
    }
}

export function convertMathMitex(
    source: string,
    notation: string = 'latex',
    display: boolean = false,
): string | undefined {
    return convertMathWithMitex(source, notation, display).typst;
}
