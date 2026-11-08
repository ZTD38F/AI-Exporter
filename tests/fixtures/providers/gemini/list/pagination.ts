import { derived } from '../../provenance.js';
import { geminiList } from './builders.js';

/** Bounded pagination stress probes use page-number keys rather than 2,000 duplicated fixtures. */
export type SourceDynamicListKey =
    | `G_SOURCE_PAGINATION_BUDGET_PAGE_${number}`
    | `G_SOURCE_PHASE_BUDGET_PAGE_${number}`
    | `G_SOURCE_550_PAGE_${number}`
    | `G_SOURCE_150_PAGE_${number}`
    | `G_SOURCE_AUDIT_LOOP_PAGE_${number}`
    | `G_SOURCE_LIMIT_BOUND_PAGE_${number}`;

export function isSourceDynamicKey(key: string): key is SourceDynamicListKey {
    return /^G_SOURCE_(?:PAGINATION_BUDGET_PAGE|PHASE_BUDGET_PAGE|550_PAGE|150_PAGE|AUDIT_LOOP_PAGE|LIMIT_BOUND_PAGE)_[0-9]+$/.test(key);
}
export function sourceDynamicPage(key: SourceDynamicListKey): string {
    const matched = /^G_SOURCE_(.+)_([0-9]+)$/.exec(key);
    if (!matched) throw new Error('Invalid Gemini source List key: ' + key);
    const family = matched[1], page = Number(matched[2]);
    const max = family === '550_PAGE' ? 11
        : family === '150_PAGE' ? 3
        : family === 'AUDIT_LOOP_PAGE' || family === 'LIMIT_BOUND_PAGE' ? 2 : 2000;
    if (!Number.isSafeInteger(page) || page < 1 || page > max) {
        throw new Error('Gemini source List page outside fixture range: ' + key);
    }
    if (family === 'PAGINATION_BUDGET_PAGE') return geminiList(['page_' + page], 'tC_' + page);
    if (family === 'PHASE_BUDGET_PAGE') return geminiList(['page' + page], 'tC_' + page);
    if (family === 'AUDIT_LOOP_PAGE') return geminiList(['chat_' + page], 'tC_loop');
    if (family === 'LIMIT_BOUND_PAGE') return geminiList(['conv_' + page], 'tC_' + page);
    if (family === '550_PAGE') return geminiList(
        Array.from({ length: 50 }, (_, i) => 'conv_' + page + '_' + i),
        page < 11 ? 'tC_' + page : null,
    );
    if (family === '150_PAGE') return geminiList(
        Array.from({ length: 50 }, (_, i) => 'chat' + ((page - 1) * 50 + i)),
        page < 3 ? 'tC_' + (page - 1) : null,
    );
    throw new Error('Unknown Gemini source List family: ' + key);
}


/** Applies to all six bounded page families, including constructed (nonliteral) keys. */
export const paginationOrigin = derived(['tests/fixtures/provider/gemini_list/recent.json'],
    'Captured List envelope/rows with synthetic page identities, cursor cycles and finite budgets.');
