import { normId } from './pathUtils.js';

/** Source text helpers without Application export-state or UI dependencies. */
export const RESEARCH_PROMPT_PREFIX_RE = /^(?:我已经完成了研究|我拟定了一个研究方案|I've completed your research|Here is a research plan)/i;

function cleanZeroWidth(t: unknown): string {
    return String(t || '').replace(/[\u200E\u200B\uFEFF\u00A0]/g, '').trim();
}

export function isBrandPlaceholderTitle(t: unknown): boolean {
    if (!t) return true;
    return /^(?:(?:Google\s+)?(?:Gemini|Bard|Google\s+AI|Google\s+Account)|New chat|新对话|未命名对话|未命名|Untitled conversation|Untitled Chat|Untitled|Document|Search|搜索)$/i.test(cleanZeroWidth(t));
}

export function isRealTitle(title?: string | null, id?: string | number): boolean {
    if (!title || typeof title !== 'string') return false;
    let t = title.trim();
    if (!t || t.length < 2) return false;
    if (t === 'Untitled' || t === '未命名' || t === 'New chat' || t === '新对话') return false;
    if (id) {
        let cleanId = normId(id);
        let cleanT = normId(t);
        if (cleanT === cleanId) return false;
        if (cleanT.startsWith('未命名对话(') || cleanT.startsWith('Untitled(')) return false;
        if (cleanT === 'c_' + cleanId || cleanId === 'c_' + cleanT) return false;
    }
    if (/^(未命名对话|Untitled conversation|Untitled|Document|Gemini|Google Gemini|Bard|Google Bard|Google AI|New chat|新对话|Search|搜索)$/i.test(t)) return false;
    if (/^(Google\s+)?(Gemini|Bard|Google\s+AI)$/i.test(t)) return false;
    if (/^(Google Account|Sign in|Sign-in|Sign in with Google|登录|重新登录)/i.test(t)) return false;
    if (/^[a-f0-9_-]{8,64}$/i.test(t)) return false;
    if (/^[0-9a-f]{16}$/i.test(t) || /^c_[0-9a-f]{16}$/i.test(t)) return false;
    if (RESEARCH_PROMPT_PREFIX_RE.test(t)) return false;
    return true;
}

export function unescapeHtml(text?: string | null): string {
    if (!text || typeof text !== 'string') return '';
    return text
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function removeElementBlocks(input: string, tagName: string): string {
    let current = input;
    const openToken = `<${tagName}`;
    const closeToken = `</${tagName}`;
    let searchFrom = 0;
    while (searchFrom < current.length) {
        const lower = current.toLowerCase();
        const startIdx = lower.indexOf(openToken, searchFrom);
        if (startIdx === -1) break;
        const afterOpen = current.charAt(startIdx + openToken.length);
        if (afterOpen && afterOpen !== '>' && afterOpen !== '/' && !/\s/.test(afterOpen)) {
            searchFrom = startIdx + openToken.length;
            continue;
        }
        const closeStart = lower.indexOf(closeToken, startIdx + openToken.length);
        if (closeStart === -1) {
            current = current.slice(0, startIdx);
            break;
        }
        const closeEnd = current.indexOf('>', closeStart + closeToken.length);
        if (closeEnd === -1) {
            current = current.slice(0, startIdx);
            break;
        }
        current = current.slice(0, startIdx) + current.slice(closeEnd + 1);
        searchFrom = startIdx;
    }
    return current;
}

export function stripHtmlTags(html?: string | null): string {
    if (!html || typeof html !== 'string') return '';
    let res = html;
    let prev = '';
    while (res !== prev) {
        prev = res;
        res = removeElementBlocks(res, 'script');
        res = removeElementBlocks(res, 'style');
        let tagStart = res.indexOf('<');
        while (tagStart !== -1) {
            const tagEnd = res.indexOf('>', tagStart + 1);
            if (tagEnd === -1) break;
            res = res.slice(0, tagStart) + res.slice(tagEnd + 1);
            tagStart = res.indexOf('<');
        }
    }
    return res;
}

export function cleanTitle(rawTitle?: string | null): string {
    if (!rawTitle || typeof rawTitle !== 'string') return '';
    let t = rawTitle.replace(/\u00a0/g, ' ').replace(/[\r\n\t]+/g, ' ').trim();
    if (/^(Google\s+)?(Gemini|Bard|Google\s+AI)$/i.test(t)) return '';
    t = t.replace(/\s*[-–—|·•]\s*(Google\s+)?(Gemini|Bard|Google\s+AI).*$/i, '');
    t = t.replace(/^(Google\s+)?(Gemini|Bard|Google\s+AI)\s*[-–—|·•]\s*/i, '');
    t = t.trim();
    if (/^(Google\s+)?(Gemini|Bard|Google\s+AI)$/i.test(t)) return '';
    return t;
}

export function resolveDetailTitle(
    messages: ({ role?: unknown; content?: unknown } | null | undefined)[] | null | undefined,
    convId?: string | number
): { title: string; source: 'derived' } | null {
    if (!Array.isArray(messages)) return null;
    const firstUser = messages.find(m => m && m.role === 'user' && m.content && String(m.content).trim());
    if (!firstUser) return null;
    const rawContent = String(firstUser.content).trim().slice(0, 60).replace(/\n+/g, ' ');
    const candidate = cleanTitle(rawContent);
    if (isRealTitle(candidate, convId)) {
        return { title: candidate, source: 'derived' };
    }
    return null;
}

