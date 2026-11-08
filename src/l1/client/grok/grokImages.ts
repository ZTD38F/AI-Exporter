import { OperationError } from '../../../shared/errors/operationError.js';
import { hasGrokAccess } from './grokSource.js';
import { grokUuid } from '../../parsers/grok/source.js';

/** Trusted shape assembled by our isolated-world DOM collector. */
export interface GrokCapturedImage {
    responseId: string;
    original_src: string;
    format: string;
    source: 'user_upload' | 'ai_generated';
}

/** Loominary's image selectors, with exact response ownership and account checks. */
export async function readGrokImages(conversationId: string, owner: string): Promise<GrokCapturedImage[]> {
    if (!grokUuid(conversationId) || !grokUuid(owner)) throw new TypeError('Invalid Grok image context');
    if (!await hasGrokAccess()) throw new OperationError('PLATFORM_PERMISSION_REQUIRED', 'Grok host permission unavailable');
    const tabs = await chrome.tabs.query({ url: ['https://grok.com/*'] });
    const results: GrokCapturedImage[] = [];
    for (const tab of tabs) {
        if (tab.id === undefined) continue;
        const response = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED',
            func: async (conversation: string, account: string) => {
                if (location.pathname !== '/c/' + conversation) return [];
                const verify = async () => {
                    const r = await fetch('/rest/auth/get-user', { credentials: 'include' });
                    const user: unknown = r.ok ? await r.json() : null;
                    return !!user && typeof user === 'object' && 'userId' in user && user.userId === account;
                };
                if (!await verify()) return [];
                const rows: GrokCapturedImage[] = [];
                const seen = new Set<string>();
                const images = document.querySelectorAll<HTMLImageElement>(
                    '[id^="response-"] img[src*="assets.grok.com"][src*="/generated/"],[data-testid="image-viewer"] img[src*="assets.grok.com"],figure img[src*="assets.grok.com"][src*="preview-image"]');
                for (const img of images) {
                    if (img.parentElement?.style.filter.includes('blur')) continue;
                    const responseId = img.closest('[id^="response-"]')?.id.slice('response-'.length);
                    if (!responseId || !/^[\da-f-]{36}$/i.test(responseId)) continue;
                    const uri = new URL(img.src);
                    if (uri.origin !== 'https://assets.grok.com') continue;
                    const uploaded = !!img.closest('figure') && uri.pathname.includes('/preview-image');
                    const original = uploaded ? uri.href.split('/preview-image')[0] : uri.href;
                    const key = responseId + ':' + original;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    rows.push({ responseId, original_src: original, format: 'image/' + (/\.png(?:\?|$)/i.test(original) ? 'png' : /\.webp(?:\?|$)/i.test(original) ? 'webp' : 'jpeg'),
                        source: uploaded ? 'user_upload' : 'ai_generated' });
                }
                return await verify() && location.pathname === '/c/' + conversation ? rows : [];
            }, args: [conversationId, owner] });
        for (const entry of response) if (Array.isArray(entry.result)) results.push(...entry.result);
    }
    return results;
}
