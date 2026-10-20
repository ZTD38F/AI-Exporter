/**
 * src/core/export/typst/mathConverter.ts
 *
 * Production math converter entry point.
 * Powered exclusively by the MiTeX WASM engine and Typst scope (Phase T / PR 5).
 */

export {
    convertMathWithMitex,
    convertMathWithMitex as convertMathWithDiagnostic,
    convertMathMitex,
    convertMathMitex as convertMath,
    initMitexWasm,
    isMitexReady,
    mitexConvertMath,
    resetMitexForTesting,
    simulateMitexInitFailureForTesting,
    type MathConversionResult,
} from './mitex/index.js';


