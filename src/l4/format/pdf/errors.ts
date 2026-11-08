import type { ResourceFailure } from '../../../shared/resources/resourceResult.js';

export function isAbortError(e: unknown): boolean {
    return (
        (e instanceof DOMException && e.name === 'AbortError') ||
        (typeof e === 'object' && e !== null && 'name' in e && e.name === 'AbortError')
    );
}

/** Image resolution failures abort this compile; Format does not retry or reacquire. */
export class PdfResourceError extends Error {
    constructor(readonly failures: readonly ResourceFailure[]) {
        super('PDF image resources unavailable');
        this.name = 'PdfResourceError';
    }
}
