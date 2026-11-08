import type { GeminiIndexObservationInput } from '../parseIndexObservation.js';
import { cleanTitle, isRealTitle } from '../../../../shared/utils/titleText.js';

function activeTitle(document: Document, activeId: string): { title: string; source: string } | null {
    const titleEls = document.querySelectorAll('[data-test-id="conversation-title"], .conversation-title, h1, [class*="conversation-title"]');
    for (const el of Array.from(titleEls)) {
        const t = cleanTitle(el.textContent || '');
        if (isRealTitle(t, activeId)) return { title: t, source: 'dom' };
    }
    const activeLink = document.querySelector(`a[href*="${activeId}"]`);
    if (activeLink) {
        const t = cleanTitle(activeLink.querySelector('.title, [class*="title"]')?.textContent || activeLink.textContent || '');
        if (isRealTitle(t, activeId)) return { title: t, source: 'dom' };
    }
    if (document.title) {
        const t = cleanTitle(document.title);
        if (isRealTitle(t, activeId)) return { title: t, source: 'dom' };
    }
    const firstUserQuery = document.querySelector('user-query .query-text, user-query [data-test-id="query-text"], user-query p, user-query');
    if (firstUserQuery) {
        const t = cleanTitle((firstUserQuery.textContent || '').trim().slice(0, 60).replace(/\n+/g, ' '));
        if (isRealTitle(t, activeId)) return { title: t, source: 'sniff' };
    }
    return null;
}

/** Current page metadata -> Domain; DOM title precedence and message-count meaning stay here. */
export function parseGeminiDomIndex(document: Document | null, id: string): GeminiIndexObservationInput {
    const title = document ? activeTitle(document, id) : null;
    const count = document?.querySelectorAll('user-query, model-response').length ?? 0;
    return { id, ...(title ? { title: title.title, titleSource: title.source } : {}),
        ...(count > 0 ? { messageCount: count } : {}) };
}
