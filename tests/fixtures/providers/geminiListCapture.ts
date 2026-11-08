import { editCapturedRpc } from './geminiCaptureWire.js';
import corpusJson from '../provider/gemini_list/recent.json';

interface CapturedListPage {
    capturedAt: string;
    method: string;
    endpoint: string;
    status: number;
    captureKind: string;
    requestBody: string;
    responseBody: string;
}

// The corpus is transport data, independent of the production parser. Return a
// fresh object each time; response/request strings themselves are immutable.
const corpus: { packets: CapturedListPage[] } = corpusJson;
export function geminiListPage(index = 0): CapturedListPage {
    const page = corpus.packets[index];
    if (!page) throw new RangeError(`No captured Gemini List page ${index}`);
    const { capturedAt, method, endpoint, status, captureKind, requestBody, responseBody } = page;
    return { capturedAt, method, endpoint, status, captureKind, requestBody, responseBody };
}
export function geminiListPages(): CapturedListPage[] {
    return corpus.packets.map((_, index) => geminiListPage(index));
}

/** Fixed expectations from the capture, never calculated with parseList. */
export const GEMINI_LIST_CAPTURE = {
    pageCount: 23,
    totalRows: 458,
    firstPageRows: 31,
    lastPageRows: 7,
    first: { id: '0000000000000001', title: 'Captured conversation 0001', updatedAt: 1792652355202 },
    last: { id: '0000000000000458', title: 'Captured conversation 0458', updatedAt: 1788374039661 },
} as const;

/** Explicit state variants: preserve captured framing and all unmodified row slots. */
export function geminiListVariant(rows: readonly unknown[] = [], nextCursor: string | null = null): string {
    return editCapturedRpc(geminiListPage().responseBody, 'MaZiqc', inner => {
        inner[1] = nextCursor;
        inner[2] = rows;
    });
}
export function geminiListRow(id: string, title: string, seconds: number): unknown[] {
    let row: unknown[] | undefined;
    editCapturedRpc(geminiListPage().responseBody, 'MaZiqc', inner => {
        row = structuredClone((inner[2] as unknown[][])[0]);
    });
    if (!row) throw new Error('Captured List has no template row');
    row[0] = 'c_' + id;
    row[1] = title;
    row[5] = [seconds, 0];
    return row;
}
