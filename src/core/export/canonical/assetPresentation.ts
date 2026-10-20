import type { InlineNode } from './inline.js';
import type { Asset } from './assets.js';

/** Conservative fallback for legacy assets that have no provenance metadata. */
export function isHumanMeaningfulFilename(value?: string): boolean {
    if (!value?.trim()) return false;
    const name = value.trim();
    if (/^(?:[a-z][a-z\d+.-]*:\/\/|(?:data|blob|file|gs|s3|asset|internal):|[/\\])/i.test(name)) return false;
    if (/[\s]/.test(name) && !/^(?:watermarked|asset|blob)[_-]/i.test(name)) return true;
    if (/^(?:[a-f\d]{6,}[_-])?(?:watermarked[_-]?img|asset|blob|generated|provider)[_-][a-z\d_-]+(?:\.[a-z\d]+)?$/i.test(name)) return false;
    if (/^(?:rc|r|c|file|upload|attachment)[_-][a-z\d_-]{12,}(?:\.[a-z\d]+)?$/i.test(name)) return false;
    const stem = name.replace(/\.[a-z\d]{1,8}$/i, '');
    if (/^(?:watermarked[_-]?img|asset|image|img|file|attachment|blob|generated)[_-]?(?:\d+|[a-f\d-]{8,})$/i.test(stem)) return false;
    if (/^(?:[a-f\d]{16,}|[a-f\d]{8}-[a-f\d-]{27,})(?:[_-]|$)/i.test(stem)) return false;
    if (/^[\d_-]+$/.test(stem)) return false;
    return /[\p{L}]/u.test(stem);
}

/** One policy for captions, alt text, file labels, and unavailable placeholders.
 * Explicit prose wins; opaque filenames/URLs never become visible labels.
 * Schema is intentionally unchanged in Phase 1.
 */
export function assetPresentation(asset?: Asset, explicit?: string, fallback = 'Image'): { label: string; caption?: string } {
    const human = (value?: string): string | undefined => isHumanMeaningfulFilename(value) ? value!.trim() : undefined;
    const caption = human(explicit) ?? human(asset?.name) ?? (asset?.kind === 'file' ? human(asset.storageRef?.split('/').pop()) : undefined);
    return { label: caption ?? fallback, ...(caption ? { caption } : {}) };
}

export function assetCaptionText(nodes?: InlineNode[]): string | undefined {
    if (!nodes?.length) return undefined;
    return nodes.map(node => {
        if (node.type === 'text') return node.text;
        if ('children' in node) return assetCaptionText(node.children) ?? '';
        if (node.type === 'inlineCode') return node.code;
        if (node.type === 'lineBreak') return ' ';
        return '';
    }).join('');
}
