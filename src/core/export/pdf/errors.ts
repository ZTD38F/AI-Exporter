export function isAbortError(e: unknown): boolean {
    return (
        (e instanceof DOMException && e.name === 'AbortError') ||
        (typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError')
    );
}
