// src/content/domScraper.ts - DOM fallback parser and conversation list scroller
import { contentContext } from './contentContext.js';
import { GeminiUtils } from '../core/utils/utils.js';

function cleanText(t?: string | null): string {
    return t ? t.replace(/\u00a0/g, ' ').replace(/\r/g, '').trim().slice(0, 20000) : '';
}

const getUtils = () => (typeof GeminiUtils !== 'undefined'
    ? GeminiUtils
    : ((typeof globalThis !== 'undefined' && (globalThis as any).GeminiUtils) || null)) as any;
const cleanTitle = (raw?: string | null) => (getUtils()?.cleanTitle ? getUtils().cleanTitle(raw || '') : (raw || '').trim());
const isRealTitle = (t?: string | null, fallbackId?: string) => (getUtils()?.isRealTitle ? getUtils().isRealTitle(t || '', fallbackId) : !!(t && typeof t === 'string' && t.trim().length > 1));

export function parseDoc(doc: Document, id: string, url?: string): any {
    let title = doc.title ? cleanTitle(doc.title) : '';
    if (!title || title === 'Gemini') {
        const h = doc.querySelector('title');
        if (h) title = cleanTitle(h.textContent?.trim().slice(0, 60));
    }
    if (!title) title = id;
    const messages: any[] = [];
    const nodes = Array.from(doc.querySelectorAll('user-query, model-response'));
    let fallbackUsed: string | null = null;
    let finalNodes: Element[] = nodes;

    if (!finalNodes.length) {
        const fallbacks = [
            '[data-test-id*="user-query"]', '[data-test-id*="model-response"]',
            '[data-message-author-role="user"]', '[data-message-author-role="model"]',
            'div[data-test-id="conversation-turn"]',
            'div[role="article"]'
        ];
        for (const sel of fallbacks) {
            try {
                const alt = Array.from(doc.querySelectorAll(sel));
                if (alt.length) { finalNodes = alt; fallbackUsed = sel; break; }
            } catch (e) {
                if (contentContext.isDevMode()) console.debug('[GemExporter:domScraper.ts]', e);
            }
        }
    }
    if (!finalNodes.length) {
        console.warn('[Gemini Exporter][DOM] parseDoc no nodes matched for', id, 'title', title, 'html_len', doc.documentElement?.outerHTML?.length, 'fallbackUsed', fallbackUsed);
    } else if (fallbackUsed && contentContext.isDevMode()) {
        console.log('[Gemini Exporter][DOM] parseDoc fallback matched', fallbackUsed, 'count', finalNodes.length);
    }

    const sorted = [...finalNodes].sort((a, b) => {
        const pos = a.compareDocumentPosition(b);
        return (pos & 4) ? -1 : 1;
    });

    for (const node of sorted) {
        const tagName = node.tagName.toLowerCase();
        const roleAttr = (node.getAttribute && node.getAttribute('data-message-author-role')) || '';
        let isUser = tagName === 'user-query' || roleAttr === 'user';
        let isModel = tagName === 'model-response' || roleAttr === 'model';

        if (!isUser && !isModel && fallbackUsed) {
            if (node.querySelector('[data-test-id*="user-query"], .query-text-line, .query-text')) {
                isUser = true;
            } else if (node.querySelector('[data-test-id*="model-response"], .markdown, message-content')) {
                isModel = true;
            } else {
                const innerRole = node.querySelector('[data-message-author-role]');
                if (innerRole) {
                    const r = innerRole.getAttribute('data-message-author-role');
                    if (r === 'user') isUser = true;
                    else if (r === 'model') isModel = true;
                }
            }
        }
        if (!isUser && !isModel) continue;

        let text = '';
        const imgNodes = Array.from(node.querySelectorAll('img'));
        const images: any[] = [];
        const attachments: any[] = [];

        for (const imgEl of imgNodes) {
            const src = (imgEl as HTMLImageElement).src || imgEl.getAttribute('src') || '';
            if (src && !src.startsWith('data:image/svg') && !src.includes('avatar') && !src.includes('icon') && !src.includes('sparkle')) {
                const alt = imgEl.getAttribute('alt') || (isUser ? 'User Image' : 'Generated Image');
                const imgObj = {
                    type: 'image',
                    src,
                    url: src,
                    sourceUrl: src,
                    name: alt,
                    alt,
                    isGenerated: !isUser,
                    isImage: true
                };
                images.push(imgObj);
                attachments.push(imgObj);
            }
        }

        if (isUser) {
            const q = node.querySelector('.query-text-line, .query-text, [data-test-id="query-text"], p');
            if (q) text = (q.textContent || '').trim();
            if (!text) text = (node.textContent || '').trim();
            if (text || images.length) {
                const msg: any = {
                    role: 'user',
                    content: cleanText(text)
                };
                if (images.length) {
                    msg.images = images;
                    msg.attachments = attachments;
                }
                messages.push(msg);
            }
        } else {
            const md = node.querySelector('.markdown, message-content, [data-test-id="model-response-content"]') || node;
            let t = '';
            const parts = md.querySelectorAll('p, li, pre, code, h1,h2,h3, blockquote');
            if (parts.length) {
                for (const p of Array.from(parts)) {
                    let tt = (p.textContent || '').trim();
                    if (!tt) continue;
                    if (tt.length > 5000) tt = tt.slice(0, 5000);
                    const tag = p.tagName.toLowerCase();
                    if (tag === 'pre') t += '\n```\n' + tt + '\n```\n';
                    else if (tag.startsWith('h')) t += '\n### ' + tt + '\n';
                    else if (tag === 'li') t += '\n- ' + tt;
                    else t += '\n\n' + tt;
                }
            }
            if (!t) t = (md.textContent || '').trim();
            if (t || images.length) {
                const msg: any = {
                    role: 'model',
                    content: cleanText(t)
                };
                if (images.length) {
                    msg.images = images;
                    msg.attachments = attachments;
                }
                messages.push(msg);
            }
        }
    }

    const realT = isRealTitle(title, id) ? title : id;
    return {
        id,
        title: realT,
        titleSource: isRealTitle(title, id) ? 'dom' : 'default',
        url: url || `https://gemini.google.com/app/${id}`,
        messages,
        messageCount: messages.length,
        _debug: {
            fallbackUsed,
            nodeCount: finalNodes.length,
            htmlLen: doc.documentElement?.outerHTML?.length
        }
    };
}

export async function contentFetchChatDetail(id: string): Promise<any> {
    const url = `https://gemini.google.com/app/${id}`;
    let res: Response;
    try {
        res = await fetch(url, { credentials: 'include' });
    } catch (e: any) {
        return { id, title: id, messages: [], error: 'fetch failed: ' + (e?.message || e), _debug: { isNetworkError: true } };
    }
    if (!res.ok) {
        const isNotFound = res.status === 404;
        return {
            id,
            title: id,
            messages: [],
            error: `HTTP ${res.status}`,
            isDeleted: isNotFound,
            _debug: { status: res.status, isNotFound }
        };
    }
    const html = await res.text();
    if (typeof DOMParser === 'undefined') {
        return { id, title: id, messages: [], _raw: { htmlLen: html.length } };
    }
    const doc = new DOMParser().parseFromString(html, 'text/html');
    let parsed = parseDoc(doc, id, url);
    if (!parsed.messages.length) {
        try {
            const cleanId = String(id).replace(/^c_/, '');
            if (typeof location !== 'undefined' && (location.pathname.includes(cleanId) || location.href.includes(cleanId))) {
                const liveFallback = parseDoc(document, id, location.href);
                if (liveFallback.messages.length) {
                    console.log('[Gemini Exporter][DOM] live fallback success after fetch empty', id);
                    return liveFallback;
                }
            }
        } catch {}
    }
    return parsed;
}

export function getScrollContainer(): HTMLElement | null {
    if (typeof document === 'undefined') return null;
    const selectors = [
        'chat-history-list',
        'div[data-test-id="chat-history-container"]',
        'nav[aria-label*="History"]',
        'nav[aria-label*="历史"]',
        'infinite-scroller',
        '.chat-history',
        'div.history-container'
    ];
    for (const s of selectors) {
        const el = document.querySelector(s) as HTMLElement;
        if (el) return el;
    }
    return null;
}

const RESERVED_ROUTES = new Set([
    'download', 'settings', 'prompts', 'archive', 'trash', 'share',
    'activity', 'help', 'feedback', 'gems', 'explore', 'privacy', 'terms', 'updates', 'faq'
]);

export function isReservedRoute(id?: string | null): boolean {
    if (!id || typeof id !== 'string') return false;
    const clean = id.replace(/^c_/, '').trim().toLowerCase();
    return RESERVED_ROUTES.has(clean);
}

export function getConversationLinks(): any[] {
    if (typeof document === 'undefined') return [];
    const items: any[] = [];
    const links = document.querySelectorAll('a[href*="/app/"]');
    for (const a of Array.from(links)) {
        const href = (a as HTMLAnchorElement).href || a.getAttribute('href') || '';
        const m = href.match(/\/app\/(c_)?([A-Za-z0-9_-]{8,})/);
        if (m) {
            const id = m[2].replace(/^c_/, '');
            if (isReservedRoute(id)) continue;
            const rawTitle = (a.querySelector('.title, [class*="title"]')?.textContent || a.textContent || '').trim();
            const title = cleanTitle(rawTitle);
            const isReal = isRealTitle(title, id);
            const titlesObj: Record<string, string> = {};
            if (isReal) titlesObj.dom = title;
            items.push({
                id,
                title: isReal ? title : '未命名对话',
                titleSource: isReal ? 'dom' : 'default',
                titles: titlesObj,
                url: `https://gemini.google.com/app/${id}`,
                href: `https://gemini.google.com/app/${id}`
            });
        }
    }
    return items;
}

export function tryExpandRecents(): void {
    try {
        const btn = document.querySelector('button[aria-label="Toggle Recents"]') || document.querySelector('[aria-label="Toggle Recents"]');
        if (btn && (btn as HTMLElement).getAttribute('aria-expanded') === 'false') (btn as HTMLElement).click();
    } catch (e) {
        if (contentContext.isDevMode()) console.debug('[GemExporter:domScraper.ts]', e);
    }
}

export function debugCurrentPage(): any {
    try {
        const doc = document;
        const info: Record<string, any> = {
            title: doc.title,
            url: typeof location !== 'undefined' ? location.href : '',
            userQuery: doc.querySelectorAll('user-query').length,
            modelResponse: doc.querySelectorAll('model-response').length,
            altSelectors: {},
            htmlLen: doc.documentElement?.outerHTML?.length || 0,
            bodySnippet: (doc.body?.innerText || '').slice(0, 600)
        };
        const alts = ['[data-test-id*="user-query"]', '[data-test-id*="model-response"]', '[data-message-author-role]', 'div[role="article"]'];
        alts.forEach(s => {
            try { info.altSelectors[s] = doc.querySelectorAll(s).length; } catch (e) { if (contentContext.isDevMode()) console.debug('[GemExporter:domScraper.ts]', e); }
        });
        if (contentContext.isDevMode()) console.log('[Gemini Exporter][DOM Debug]', info);
        return info;
    } catch (e) {
        console.warn('debugCurrentPage fail', e);
        return null;
    }
}

export const DomScraper = {
    cleanText,
    parseDoc,
    contentFetchChatDetail,
    getScrollContainer,
    getConversationLinks,
    tryExpandRecents,
    debugCurrentPage
};



(DomScraper as any).DomScraper = DomScraper;
(DomScraper as any).default = DomScraper;

if (typeof globalThis !== 'undefined') {
    (globalThis as any).DomScraper = DomScraper;
}
if (typeof module !== 'undefined' && (module as any).exports) {
    (module as any).exports = DomScraper;
}

export default DomScraper;
