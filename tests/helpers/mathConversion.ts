import { convertMathWithMitex } from '../../src/l4/format/typst/mathConverter.js';

/** Test fixture for the historical string-only math converter contract. */
export function convertMathForTest(source: string, display: boolean): string | undefined {
    return convertMathWithMitex(source, 'latex', display).typst;
}
