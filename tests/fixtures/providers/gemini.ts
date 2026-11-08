import { listCases as fixtureMap } from './gemini/list/cases.js';
import { isSourceDynamicKey, sourceDynamicPage } from './gemini/list/pagination.js';
import type { SourceDynamicListKey } from './gemini/list/pagination.js';

/** One generator entrypoint for all finite and bounded native MaZiqc wire samples. */
export function listGen(key: keyof typeof fixtureMap | SourceDynamicListKey): string {
    if (isSourceDynamicKey(key)) return sourceDynamicPage(key);
    return fixtureMap[key]();
}
