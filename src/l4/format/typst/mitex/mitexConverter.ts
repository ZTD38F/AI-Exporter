/**
 * src/l4/format/typst/mitex/mitexConverter.ts
 *
 * Controlled LaTeX -> Typst math converter backed by MiTeX WASM engine.
 * Conforms to TeX Migration Gate requirements (Plan Section 28):
 * - Fail-closed: Never crashes on malformed LaTeX; catches errors, emits TYPST_MATH_CONVERT_FAILED, preserves raw LaTeX.
 * - Standard semantics: Preserves MiTeX upstream LaTeX authority with zero speculative compatibility rules.
 */

import type { Diagnostic as RenderDiagnostic } from '../../../../shared/diagnostics/diagnostic.js';
import { preprocessLatex } from '../../../../shared/utils/latexCompatibility.js';
import { mitexConvertMath } from './mitexLoader.js';

interface MathConversionResult {
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
    notation = 'latex',
    display = false,
): MathConversionResult {

    if (notation !== 'latex') {
        return {
            diagnostic: warn(
                'TYPST_MATH_UNSUPPORTED_NOTATION',
                `Math notation '${notation}' is not supported by the controlled converter (only 'latex'); raw source preserved.`,
            ),
        };
    }

    if (source.trim() === '') {
        return {
            diagnostic: warn(
                'TYPST_MATH_EMPTY',
                'Empty math source cannot be converted; raw source preserved.',
            ),
        };
    }

    try {
        const preprocessed = preprocessLatex(source);
        // MiTeX currently prints the optional TeX row-gap argument literally.
        // Consume only a numeric physical length after a row break; it is
        // layout metadata, never an authored matrix entry or optional root.
        const rowLayout = preprocessed.replace(/(\\\\+)\s*\[\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*(?:pt|em|ex|mm|cm|in|mu)\s*\]/g,
            (raw, slashes: string) => slashes.length % 2 === 0 ? slashes : raw);
        const typst = mitexConvertMath(rowLayout);

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
