/**
 * src/core/utils/pathUtils.ts
 * Path sanitization, file name normalization, and ID routing utilities.
 */

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

/**
 * Unified sanitizeFileName - 单一源，70字符上限，防路径穿越与 Windows 保留名
 */
export function sanitizeFileName(name?: string | null, fallback: string = 'untitled'): string {
    if (!name) return fallback;
    let s = String(name).replace(/[\r\n\t\f\v]+/g, ' ').replace(/[\u0000-\u001F\u007F-\u009F]/g, '_');
    // 防路径穿越 ../  ..\  ...
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

/**
 * Unified sanitizeRelativePath - 单一源，拆分各级相对路径分段清洗，阻断 .. 路径穿越并统一正斜杠
 */
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

export default {
    normId,
    isReservedRoute,
    RESERVED_ROUTES,
    sanitizeFileName,
    sanitizeRelativePath
};
