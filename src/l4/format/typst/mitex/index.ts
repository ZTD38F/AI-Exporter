/**
 * src/l4/format/typst/mitex/index.ts
 *
 * Public surface of the MiTeX LaTeX -> Typst conversion engine.
 */

export {
    initMitexWasm,
    isMitexReady,
    mitexConvertMath,
    resetMitexForTesting,
    simulateMitexInitFailureForTesting,
} from './mitexLoader.js';

export { convertMathWithMitex } from './mitexConverter.js';
