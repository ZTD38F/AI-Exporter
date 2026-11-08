/**
 * Source hrefs are untrusted facts, unlike Packaging's planned resource paths.
 * Do not turn relative/file/data/JS schemes into navigable links.
 */
export function safeExternalHref(href: string | undefined): string | undefined {
    if (!href || /[\u0000-\u0020\u007f-\u009f\\]/.test(href) || !/^(?:https?:\/\/|mailto:)/i.test(href)) return undefined;
    try {
        const url = new URL(href);
        if (url.protocol === 'mailto:') return url.pathname ? url.href : undefined;
        return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname ? url.href : undefined;
    } catch {
        return undefined;
    }
}

/** Allow only fragments that actually have a generated destination in this document. */
export function safeGeneratedFragment(href: string | undefined, anchors: ReadonlySet<string>): string | undefined {
    if (!href || !/^#[A-Za-z0-9_-]+$/.test(href)) return undefined;
    return anchors.has(href.slice(1)) ? href : undefined;
}

/** URL-encode every path component; don't encode '/' separators in Packaging paths. */
export function encodeResourceHref(path: string): string {
    return path.split('/').map(encodeURIComponent).join('/');
}

/** Encode punctuation which otherwise terminates a Markdown destination. */
export function encodeMarkdownHref(href: string): string {
    return href.replace(/[()<>]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
}
