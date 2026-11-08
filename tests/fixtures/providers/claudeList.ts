import { describeFixtures, synthetic } from './provenance.js';
/** Raw GET /api/organizations/:org/chat_conversations_v2 paginated JSON responses. */
const parseRows = () => [
    { uuid: '11111111-1111-4111-8111-111111111111', name: 'Older', updated_at: '2026-10-02T00:00:00Z' },
    { uuid: '22222222-2222-4222-8222-222222222222', name: 'Newer', updated_at: '2026-10-03T00:00:00Z' },
];

const providerRows = () => [
    { uuid: '22222222-2222-4222-8222-222222222222', name: 'New', updated_at: '2026-10-22T01:00:00Z' },
    { uuid: '33333333-3333-4333-8333-333333333333', name: 'Old', updated_at: '2026-10-21T01:00:00Z' },
];

const fixtureMap = {
    'CL_L1_SOURCE_PARSE_SORTED_01': () => ({ data: parseRows(), has_more: false }),
    'CL_L1_SOURCE_PARSE_DUPLICATE_01': () => ({
        data: [
            { uuid: '11111111-1111-4111-8111-111111111111', updated_at: '2026-10-02T00:00:00Z' },
            { uuid: '11111111-1111-4111-8111-111111111111', updated_at: '2026-10-02T00:00:00Z' },
        ], has_more: false,
    }),
    'CL_L1_SOURCE_PARSE_INVALID_ITEMS_01': () => ({ data: { items: [] }, has_more: false }),
    'CL_L1_SOURCE_PARSE_MISSING_TIME_01': () => ({
        data: [{ uuid: '11111111-1111-4111-8111-111111111111' }], has_more: false,
    }),
    'CL_LIST_BOUNDARY_VALID_01': () => ({ data: providerRows(), has_more: false, search_incomplete: false }),
    'CL_LIST_BOUNDARY_REVERSED_01': () => ({ data: providerRows().reverse(), has_more: false }),
    'CL_LIST_BOUNDARY_TRUNCATED_01': () => ({ data: providerRows(), has_more: true }),
    'CL_LIST_BOUNDARY_INCOMPLETE_01': () => ({ data: providerRows(), has_more: false, search_incomplete: true }),
    'CL_LIST_BOUNDARY_MISSING_FLAG_01': () => ({ data: providerRows() }),
    'CL_LIST_BOUNDARY_SEARCH_ABSENT_01': () => ({ data: providerRows(), has_more: false }),
    'CL_LIST_BOUNDARY_BAD_SEARCH_STRING_01': () => ({ data: [], has_more: false, search_incomplete: 'true' }),
    'CL_LIST_BOUNDARY_BAD_SEARCH_NUMBER_01': () => ({ data: [], has_more: false, search_incomplete: 1 }),
    'CL_LIST_BOUNDARY_BAD_SEARCH_NULL_01': () => ({ data: [], has_more: false, search_incomplete: null }),
};

/** Preserve malformed native variants so parser/provider boundary tests can reject them. */
export function listGen(key: keyof typeof fixtureMap) {
    return fixtureMap[key]();
}

export const fixtureOrigins = describeFixtures(fixtureMap, synthetic("Authored Claude protocol, content or state counterexample; no saved capture is used."));
