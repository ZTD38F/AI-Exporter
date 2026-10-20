export const RESERVED_ROUTES = new Set([
    'download', 'settings', 'prompts', 'archive', 'trash', 'share',
    'activity', 'help', 'feedback', 'gems', 'explore', 'privacy', 'terms', 'updates', 'faq'
]);

export function normId(id?: string | number | null): string {
    if (!id) return '';
    return String(id).replace(/^c_/, '').trim();
}

export function isReservedRoute(id?: string | number | null): boolean {
    if (!id) return false;
    const clean = normId(id).toLowerCase();
    return RESERVED_ROUTES.has(clean);
}

export function sanitizeFileName(name?: string | null, fallback: string = 'untitled'): string {
    if (!name) return fallback;
    let s = String(name).replace(/[\r\n\t\f\v]+/g, ' ').replace(/[\u0000-\u001F\u007F-\u009F]/g, '_');
    s = s.replace(/\.\.\//g, '_').replace(/\.\.\\/g, '_');
    s = s.replace(/[<>:"/\\|?*]+/g, '_');
    s = s.replace(/\.{2,}/g, '_');
    s = s.replace(/^\.+|\.+$/g, '');
    s = s.trim();
    if (!s) return fallback;
    let ext = '';
    const lastDot = s.lastIndexOf('.');
    if (lastDot > 0 && s.length - lastDot <= 6) {
        ext = s.slice(lastDot);
        s = s.slice(0, lastDot);
    }
    // Windows file systems prohibit DOS device reserved names
    if (/^(con|prn|aux|nul|com\d{1,2}|lpt\d{1,2})$/i.test(s)) s = s + '_chat';
    if ([...s].length > 70) s = [...s].slice(0, 70).join('').trim();
    s = s.replace(/[\.\s_]+$/g, '').trim();
    if (!s) s = fallback;
    return s + ext;
}

export function sanitizeRelativePath(p?: string | null, defaultName: string = 'file'): string {
    if (!p || typeof p !== 'string') return '';
    const segments = p.split(/[/\\]/).map(seg => {
        let clean = seg.trim();
        if (!clean || clean === '.' || clean === '..') return '_';
        clean = clean.replace(/\.\./g, '_');
        return sanitizeFileName(clean, defaultName);
    }).filter(Boolean);
    return segments.join('/');
}

export function isGeminiUrl(urlStr?: string | null): boolean {
    if (!urlStr || typeof urlStr !== 'string') return false;
    try {
        const u = new URL(urlStr);
        return u.hostname === 'gemini.google.com';
    } catch {
        return false;
    }
}

export interface AccountProfile {
    slot: string;
    accountId: string;
    email?: string;
    name?: string;
    gaiaId?: string;
    lastSync?: string;
    count?: number;
}

export function detectSlotFromUrl(urlOrPath?: string | null): string {
    if (!urlOrPath || typeof urlOrPath !== 'string') return 'u0';
    try {
        const path = urlOrPath.includes('://') ? new URL(urlOrPath).pathname : urlOrPath;
        const m = path.match(/\/u\/(\d+)(?:\/|$)/);
        return m ? `u${m[1]}` : 'u0';
    } catch {
        const m = urlOrPath.match(/\/u\/(\d+)(?:\/|$)/);
        return m ? `u${m[1]}` : 'u0';
    }
}

export function extractConversationIdFromUrl(urlOrPath?: string | null): string | null {
    if (!urlOrPath || typeof urlOrPath !== 'string') return null;
    const m = urlOrPath.match(/\/app\/(?:c_)?([A-Za-z0-9_-]{8,})/i);
    if (!m || !m[1]) return null;
    const cleanId = normId(m[1]);
    return isReservedRoute(cleanId) ? null : cleanId;
}

export function shortId(id?: string | number | null): string {
    const nid = normId(id);
    return nid.length >= 6 ? nid.slice(-6) : (nid || 'chat');
}

export function shortScope(id?: string | number | null): string {
    const nid = normId(id);
    return nid ? `${shortId(nid)}_` : '';
}

export function buildExportFileName(title?: string | null, id?: string | null, ext: string = 'md'): string {
    let safeTitle = sanitizeFileName(title || 'untitled');
    if ([...safeTitle].length > 62) {
        safeTitle = [...safeTitle].slice(0, 62).join('').trim().replace(/[\.\s_]+$/g, '') || 'untitled';
    }
    const cid6 = shortId(id);
    let cleanExt = String(ext || '').replace(/^\.+/, '');
    cleanExt = cleanExt.split(/[\\/]/).pop() || '';
    cleanExt = cleanExt.replace(/^\.+|\.+$/g, '').replace(/\.{2,}/g, '.').replace(/[^a-zA-Z0-9._-]/g, '');
    if (!cleanExt) cleanExt = 'md';
    return `${safeTitle}_${cid6}.${cleanExt}`;
}

export function isVersionGreater(v1?: string | null, v2?: string | null): boolean {
    if (!v1) return false;
    if (!v2) return true;
    const p1 = String(v1).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
    const p2 = String(v2).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
    const maxLen = Math.max(p1.length, p2.length);
    for (let i = 0; i < maxLen; i++) {
        const num1 = p1[i] || 0;
        const num2 = p2[i] || 0;
        if (num1 > num2) return true;
        if (num1 < num2) return false;
    }
    return false;
}

export function sanitizeFileNameLegacy(name?: string | null, fallback: string = 'untitled'): string {
    if (!name) return fallback;
    let s = String(name).replace(/[\r\n\t\f\v]+/g, ' ').replace(/[\u0000-\u001F\u007F-\u009F]/g, '_');
    s = s.replace(/\.\.\//g, '_').replace(/\.\.\\/g, '_');
    s = s.replace(/[<>:"/\\|?*]+/g, '_');
    s = s.replace(/\.{2,}/g, '_');
    s = s.replace(/^\.+|\.+$/g, '');
    s = s.trim();
    if (!s) return fallback;
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = s + '_chat';
    let ext = '';
    const lastDot = s.lastIndexOf('.');
    if (lastDot > 0 && s.length - lastDot <= 6) {
        ext = s.slice(lastDot);
        s = s.slice(0, lastDot);
    }
    if (s.length > 70) s = s.slice(0, 70).trim();
    s = s.replace(/[\.\s_]+$/g, '').trim();
    if (!s) s = fallback;
    return s + ext;
}

export function buildExportFileNameLegacy(title?: string | null, id?: string | null, ext: string = 'md'): string {
    const safeTitle = sanitizeFileNameLegacy(title || 'untitled');
    const nid = normId(id);
    const cid6 = nid.length >= 6 ? nid.slice(-6) : (nid || 'chat');
    const cleanExt = ext.replace(/^\.+/, '') || 'md';
    return `${safeTitle}_${cid6}.${cleanExt}`;
}

export type FileExistsFn = (name: string) => boolean | Promise<boolean>;

export async function resolveExportFileName(
    title?: string | null,
    id?: string | null,
    ext: string = 'md',
    exists?: FileExistsFn
): Promise<string> {
    const fileName = buildExportFileName(title, id, ext);
    const legacyName = buildExportFileNameLegacy(title, id, ext);
    if (!exists || legacyName === fileName) return fileName;
    try {
        if (await exists(fileName)) return fileName;
    } catch {}
    try {
        if (await exists(legacyName)) return legacyName;
    } catch {}
    return fileName;
}


export default {
    normId,
    sanitizeFileNameLegacy,
    buildExportFileNameLegacy,
    resolveExportFileName,
    shortId,
    shortScope,
    isReservedRoute,
    RESERVED_ROUTES,
    sanitizeFileName,
    sanitizeRelativePath,
    isGeminiUrl,
    detectSlotFromUrl,
    extractConversationIdFromUrl,
    buildExportFileName,
    isVersionGreater
};

