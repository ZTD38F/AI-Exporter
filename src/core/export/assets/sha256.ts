// SHA-256 via Web Crypto: the project owns only this small bytes-to-lowercase-hex
// adapter. Available in the extension's browser/worker contexts and in Node test runs.
export async function sha256Hex(data: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
    const bytes = new Uint8Array(digest);
    let hex = '';
    for (const b of bytes) hex += b.toString(16).padStart(2, '0');
    return hex;
}
