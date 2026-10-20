/** Resource namespaces written relative to the exported archive root. */
export const ARCHIVE_RESOURCE_NAMESPACES = ['assets', 'files'] as const;

export function safeDecodeURIComponent(str: string): string {
    const escaped = str.replace(/%(?![0-9a-fA-F]{2})/g, '%25');
    try {
        return decodeURIComponent(escaped);
    } catch {
        return escaped.replace(/%([0-9a-fA-F]{2})/g, (match, hex) => {
            const code = parseInt(hex, 16);
            if (code < 128) return String.fromCharCode(code);
            return match;
        });
    }
}

export function normalizeArchivePath(path: string): string {
    const normalized = path.replace(/\\/g, '/');
    let decoded: string;
    try { decoded = safeDecodeURIComponent(normalized); }
    catch { throw new Error('Invalid archive resource path encoding'); }
    if (/^(?:\/|[a-z][a-z\d+.-]*:)/i.test(decoded)
        || /[\u0000-\u001f\u007f]/.test(decoded)
        || decoded.replace(/\\/g, '/').split('/').includes('..')) {
        throw new Error('Unsafe archive resource path');
    }
    const segments = normalized.split('/').filter((segment) => segment && segment !== '.');
    if (!segments.length) throw new Error('Empty archive resource path');
    return segments.join('/');
}

export function normalizeArchiveResourceName(name: string): string {
    if (!name || /^https?:\/\//i.test(name)) return name;
    const path = normalizeArchivePath(name);
    return ARCHIVE_RESOURCE_NAMESPACES.some((namespace) => path.startsWith(`${namespace}/`))
        ? path : `assets/${path}`;
}
