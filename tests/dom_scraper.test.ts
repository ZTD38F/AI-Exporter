export {};
const test = require('node:test');
const assert = require('node:assert');
const DomScraper = require('../src/content/domScraper.js');

let nodeCounter = 0;

interface MockNode {
    _id: number;
    tagName: string;
    textContent?: string;
    attributes?: Record<string, string>;
    children?: MockNode[];
    getAttribute?: (name: string) => string | null;
    querySelector?: (selector: string) => MockNode | null;
    querySelectorAll?: (selector: string) => MockNode[];
    compareDocumentPosition?: (other: MockNode) => number;
    click?: () => void;
    clicked?: boolean;
}

function createMockElement(tag: string, attrs: Record<string, string> = {}, text = '', children: MockNode[] = []): MockNode {
    const el: MockNode = {
        _id: ++nodeCounter,
        tagName: tag.toUpperCase(),
        textContent: text,
        attributes: { ...attrs },
        children: [...children],
        clicked: false
    };

    el.getAttribute = (name: string) => el.attributes?.[name] ?? null;

    el.querySelector = (selector: string): MockNode | null => {
        const all = el.querySelectorAll!(selector);
        return all.length > 0 ? all[0] : null;
    };

    el.querySelectorAll = (selector: string): MockNode[] => {
        const results: MockNode[] = [];
        const matchSingle = (node: MockNode, sel: string): boolean => {
            const tagMatch = sel.toLowerCase() === node.tagName.toLowerCase();
            const classMatch = sel.startsWith('.') && (node.attributes?.['class'] || '').includes(sel.slice(1));
            const attrMatch = sel.startsWith('[') && sel.endsWith(']');
            if (attrMatch) {
                const inner = sel.slice(1, -1);
                if (inner.includes('*=')) {
                    const [k, v] = inner.split('*=').map(s => s.replace(/['"]/g, ''));
                    return (node.attributes?.[k] || '').includes(v);
                } else if (inner.includes('=')) {
                    const [k, v] = inner.split('=').map(s => s.replace(/['"]/g, ''));
                    return (node.attributes?.[k] || '') === v;
                }
                return !!node.attributes?.[inner];
            }
            if (sel.includes('[') && sel.includes(']')) {
                const prefixTag = sel.split('[')[0].trim();
                const attrPart = sel.slice(sel.indexOf('[') + 1, -1);
                const tagOk = !prefixTag || prefixTag.toLowerCase() === node.tagName.toLowerCase();
                if (!tagOk) return false;
                if (attrPart.includes('=')) {
                    const [k, v] = attrPart.split('=').map(s => s.replace(/['"]/g, ''));
                    return (node.attributes?.[k] || '') === v;
                }
                return !!node.attributes?.[attrPart];
            }
            return tagMatch || classMatch;
        };

        const traverse = (current: MockNode) => {
            for (const child of (current.children || [])) {
                const parts = selector.split(',').map(s => s.trim());
                if (parts.some(p => matchSingle(child, p))) {
                    results.push(child);
                }
                traverse(child);
            }
        };

        traverse(el);
        return results;
    };

    el.compareDocumentPosition = (other: MockNode) => {
        return (el._id < (other?._id || 0)) ? 4 : 2;
    };
    el.click = () => { el.clicked = true; };

    return el;
}

test('dom_scraper - cleanText functionality', () => {
    assert.strictEqual(DomScraper.cleanText('  Hello\u00a0World\r\n  '), 'Hello World');
    assert.strictEqual(DomScraper.cleanText(''), '');
    assert.strictEqual(DomScraper.cleanText(null), '');
    assert.strictEqual(DomScraper.cleanText(undefined), '');
});

test('dom_scraper - isReservedRoute route detection', () => {
    assert.strictEqual(DomScraper.isReservedRoute('download'), true);
    assert.strictEqual(DomScraper.isReservedRoute('c_settings'), true);
    assert.strictEqual(DomScraper.isReservedRoute('trash'), true);
    assert.strictEqual(DomScraper.isReservedRoute('explore'), true);
    assert.strictEqual(DomScraper.isReservedRoute('c_1bd028d5c5b0c0e2'), false);
    assert.strictEqual(DomScraper.isReservedRoute('normal_chat_id'), false);
    assert.strictEqual(DomScraper.isReservedRoute(''), false);
    assert.strictEqual(DomScraper.isReservedRoute(null), false);
});

test('dom_scraper - parseDoc extracts messages, images, and title correctly', () => {
    const userImg = createMockElement('img', { src: 'https://cdn.google.com/test_user.png', alt: 'Test Photo' });
    const userQuery = createMockElement('user-query', {}, '', [
        createMockElement('div', { class: 'query-text' }, '请分析这张图片'),
        userImg
    ]);

    const modelResp = createMockElement('model-response', {}, '', [
        createMockElement('div', { class: 'markdown' }, '', [
            createMockElement('p', {}, '这是第一段解析。'),
            createMockElement('pre', {}, 'console.log("ok");'),
            createMockElement('li', {}, '要点 A')
        ])
    ]);

    const titleEl = createMockElement('title', {}, '量子力学与量子纠缠探讨 - Google Gemini');
    const root = createMockElement('html', {}, '', [titleEl, userQuery, modelResp]);

    const mockDoc: any = {
        title: '量子力学与量子纠缠探讨 - Google Gemini',
        documentElement: root,
        querySelector: (sel: string) => root.querySelector!(sel),
        querySelectorAll: (sel: string) => root.querySelectorAll!(sel)
    };

    const parsed = DomScraper.parseDoc(mockDoc, 'chat_001');

    assert.strictEqual(parsed.id, 'chat_001');
    assert.strictEqual(parsed.titleSource, 'dom');
    assert.ok(parsed.title.includes('量子力学与量子纠缠探讨'), `Title should be cleaned: ${parsed.title}`);
    assert.strictEqual(parsed.messages.length, 2);

    assert.strictEqual(parsed.messages[0].role, 'user');
    assert.strictEqual(parsed.messages[0].content, '请分析这张图片');
    assert.strictEqual(parsed.messages[0].images.length, 1);
    assert.strictEqual(parsed.messages[0].images[0].src, 'https://cdn.google.com/test_user.png');

    assert.strictEqual(parsed.messages[1].role, 'model');
    assert.ok(parsed.messages[1].content.includes('这是第一段解析'));
    assert.ok(parsed.messages[1].content.includes('```\nconsole.log("ok");\n```'));
    assert.ok(parsed.messages[1].content.includes('- 要点 A'));
});

test('dom_scraper - parseDoc fallbacks when standard tags are absent', () => {
    const turn1 = createMockElement('div', { 'data-test-id': 'conversation-turn' }, '', [
        createMockElement('div', { class: 'query-text' }, '用户提问内容')
    ]);
    const turn2 = createMockElement('div', { 'data-test-id': 'conversation-turn' }, '', [
        createMockElement('div', { class: 'markdown' }, '模型回复内容')
    ]);

    const root = createMockElement('div', {}, '', [turn1, turn2]);
    const mockDoc: any = {
        title: '',
        documentElement: root,
        querySelector: (sel: string) => root.querySelector!(sel),
        querySelectorAll: (sel: string) => root.querySelectorAll!(sel)
    };

    const parsed = DomScraper.parseDoc(mockDoc, 'c_fallback_test');
    assert.strictEqual(parsed.messages.length, 2);
    assert.strictEqual(parsed.messages[0].role, 'user');
    assert.strictEqual(parsed.messages[0].content, '用户提问内容');
    assert.strictEqual(parsed.messages[1].role, 'model');
    assert.strictEqual(parsed.messages[1].content, '模型回复内容');
    assert.strictEqual(parsed.title, 'c_fallback_test');
});

test('dom_scraper - getScrollContainer locates history scroller element', () => {
    const origDoc = (global as any).document;
    try {
        const mockContainer = createMockElement('nav', { 'aria-label': 'Chat History 历史记录' });
        (global as any).document = {
            querySelector: (sel: string) => {
                if (sel.includes('历史') || sel.includes('History')) return mockContainer;
                return null;
            }
        };

        const res = DomScraper.getScrollContainer();
        assert.ok(res, 'Scroll container should be found');
        assert.strictEqual(res.getAttribute('aria-label'), 'Chat History 历史记录');
    } finally {
        (global as any).document = origDoc;
    }
});

test('dom_scraper - getConversationLinks parses links and skips reserved routes', () => {
    const origDoc = (global as any).document;
    try {
        const link1 = createMockElement('a', { href: 'https://gemini.google.com/app/1bd028d5c5b0c0e2' }, '火星猫咪');
        const link2 = createMockElement('a', { href: 'https://gemini.google.com/app/trash' }, '垃圾桶');
        const link3 = createMockElement('a', { href: 'https://gemini.google.com/app/c_7b29852ecae8344a' }, '贝尔不等式推导');

        (global as any).document = {
            querySelectorAll: (sel: string) => {
                if (sel.includes('a[href*="/app/"]')) return [link1, link2, link3];
                return [];
            }
        };

        const links = DomScraper.getConversationLinks();
        assert.strictEqual(links.length, 2, 'Should skip reserved route /trash');
        assert.strictEqual(links[0].id, '1bd028d5c5b0c0e2');
        assert.strictEqual(links[0].title, '火星猫咪');
        assert.strictEqual(links[0].titleSource, 'dom');
        assert.strictEqual(links[1].id, '7b29852ecae8344a');
        assert.strictEqual(links[1].title, '贝尔不等式推导');
    } finally {
        (global as any).document = origDoc;
    }
});

test('dom_scraper - tryExpandRecents clicks expand buttons safely', () => {
    const origDoc = (global as any).document;
    try {
        const expandBtn = createMockElement('button', { 'aria-label': 'Toggle Recents', 'aria-expanded': 'false' });
        (global as any).document = {
            querySelector: (sel: string) => {
                if (sel.includes('Toggle Recents')) return expandBtn;
                return null;
            }
        };

        DomScraper.tryExpandRecents();
        assert.strictEqual(expandBtn.clicked, true, 'Expand button should be clicked');
    } finally {
        (global as any).document = origDoc;
    }
});
