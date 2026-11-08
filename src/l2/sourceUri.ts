/** Temporary bytes and signed download credentials are execution hints, not durable locators. */
export function isDurableSourceUri(value: unknown): value is string {
    if (typeof value !== 'string' || !value || value !== value.trim() || /^(?:data|blob):/i.test(value)) return false;
    try {
        const url = new URL(value, 'https://source-locator.invalid/');
        // Preserve source queries intact; signed URLs cannot be made durable by stripping parameters.
        return ![...url.searchParams.keys()].some(key => /^(?:x-goog-.*|x-amz-.*|signature|sig|expires|policy|key-pair-id|access_token|auth_token|token)$/i.test(key));
    } catch { return !value.includes('://'); } // Relative archive references are durable source facts.
}
