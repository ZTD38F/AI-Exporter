/**
 * src/l4/format/typst/mathConverter.ts
 *
 * Production math converter entry point.
 * Powered exclusively by the MiTeX WASM engine and Typst scope (Phase T / PR 5).
 */

export { convertMathWithMitex, initMitexWasm, isMitexReady, resetMitexForTesting, simulateMitexInitFailureForTesting } from './mitex/index.js';


