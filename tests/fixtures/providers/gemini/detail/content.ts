import { rpc, domainTurn, boundaryTurn } from './protocol.js';
import { citationFile } from './sources.js';

/** hNvQHb responses for structured-content coverage probes and captured evidence. */
const COVERAGE_FALLBACK = 'MARKDOWN_FALLBACK_SENTINEL';

export function coverageTextNode(value: string, flag: number): unknown[] {
    return [null, [null, 0, value, [[0, value.length, [[null, null, null, null, flag]]]]]];
}

export function coverageWire(raw: unknown, candidates: unknown[] = [['rc_answer', [[COVERAGE_FALLBACK]]]]): string {
    const payload: unknown[] = [candidates];
    if (raw !== undefined) payload[12] = raw;
    return JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify([[[['c_coverage', 'r_coverage'], [1700000000, 0], [['Question']], payload]]])]]);
}

/** Source-attribution probes: each key resolves one native hNvQHb response. */
const citationFallback = 'UNRELATED_MARKDOWN_SENTINEL';

export const citationText = (value: string, annotations: unknown[] = []): unknown[] => [null, [null, 0, value, annotations]];

export const citationField = (index: number, value: unknown): unknown[] =>
    Object.assign(Array(index + 1).fill(null), { [index]: value });

export const citationSourceAnnotation = (start: number, end: number, ids = ['spp_fixture']): unknown[] =>
    [start, end, [null, null, null, [null, ids]]];

export const citationSourceTable = (sources: unknown[] = [['https://example.com/source', 'Source title']]): unknown[] =>
    [null, [[['cited span'], [1], sources, 'spp_fixture']]];

export function citationWire(raw: unknown, table?: unknown, alternatives: unknown[] = []): string {
    const payload: unknown[] = [[['rc_primary', [[citationFallback]], table], ...alternatives]];
    payload[12] = raw;
    return JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify([
        [[['c_citationfixture', 'r_fixture'], [1700000000, 0], [['Question']], payload]],
    ])]]);
}

/** Previously inline malformed citation probes, encoded as distinct source responses. */
export function citationInvalidFileMarker(marker: string): string {
    const copy = citationFile('live-combined-file-citations') as unknown[][][][];
    const node = copy[0][0][0] as unknown[];
    const payload = node[31] as unknown[][][];
    payload[0][0][0] = marker;
    return citationWire(copy);
}

/** Four finite composite-layout variants with the original captured citation node. */
export function citationCompositeWire(kind: 'paragraph' | 'list' | 'table' | 'quote'): string {
    const fileCitation = { nodeType: 'citation', number: 1, title: 'test_config.json' };
    const second = { ...fileCitation, number: 2, title: 'other.png' };
    const composite = { nodeType: 'paragraph', children: [
        { nodeType: 18, text: '😀 x_1', annotations: [{ start: 3, end: 6, type: 4 }] },
        fileCitation, { nodeType: 18, text: ' / ' }, second, { nodeType: 18, text: '. [1]' },
    ] };
    const node = kind === 'list' ? { nodeType: 20, items: [{ children: [composite] }] }
        : kind === 'table' ? { nodeType: 17, rows: [{ cells: [{ children: [composite] }] }] }
        : kind === 'quote' ? { nodeType: 15, children: [composite] } : composite;
    return citationWire({ children: [node] });
}

export function citationInlineCombinedWire(): string {
    // Embed the saved native citation nodes directly; never decode them to
    // manufacture a second input for the production decoder under test.
    const captured = citationFile('live-combined-file-citations') as unknown[][][];
    return citationWire([[[citationField(13, [[
        citationText('Before '), ...captured[0][0], citationText(' after.'),
    ]])]]]);
}

export function domainCapturedStructuredWire(): string {
    const candidate = citationFile('wire-case-b-cand');
    const structured = citationFile('wire-turn-3-12-b-stack');
    const rawTurn = domainTurn('Explain Bell inequalities', null, [candidate]);
    const model = rawTurn[3] as unknown[];
    model[12] = structured;
    return rpc([[rawTurn]]);
}

export function boundaryCapturedDocumentWire(truncated = false): string {
    const candidate = citationFile('wire-case-b-cand');
    const document = citationFile('wire-turn-3-12-b-stack');
    const rawTurn = boundaryTurn('Explain Bell inequalities', null, [candidate]);
    const model = rawTurn[3] as unknown[];
    model[12] = truncated ? [[[null]]] : document;
    return rpc([[rawTurn]]);
}
