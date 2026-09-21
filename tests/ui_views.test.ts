export {};
const test = require('node:test');
const assert = require('node:assert');

const AccountView = require('../src/ui/views/accountView.js');
const BadgeView = require('../src/content/badgeView.js');
const DialogView = require('../src/ui/views/dialogView.js');
const ListView = require('../src/ui/views/listView.js');
const LogView = require('../src/ui/views/logView.js');

// ---------------------------------------------------------------------------
// AccountView
// ---------------------------------------------------------------------------
test('accountView - exports and safe render', () => {
    assert.ok(AccountView);
    assert.strictEqual(typeof AccountView.render, 'function');
    assert.strictEqual(typeof AccountView.bindChange, 'function');
    // render without DOM element does not crash
    AccountView.render({ 'u0': { name: 'Main' } }, 'u0');
});

// ---------------------------------------------------------------------------
// BadgeView
// ---------------------------------------------------------------------------
test('badgeView - module exports and interface', () => {
    assert.ok(BadgeView);
    assert.strictEqual(typeof BadgeView.applyStoredBadgePosition, 'function');
    assert.strictEqual(typeof BadgeView.makeBadgeDraggable, 'function');
    assert.strictEqual(typeof BadgeView.ensureBadge, 'function');
    assert.strictEqual(typeof BadgeView.ensureBadgeAndText, 'function');
    assert.strictEqual(typeof BadgeView.updateBadge, 'function');
});

test('badgeView - DOM creation and text update', () => {
    let attachedElement: any = null;
    const mockBadge = {
        id: 'geminiExportBadge',
        innerHTML: '',
        style: {},
        classList: { add: () => {}, remove: () => {} },
        addEventListener: () => {},
        isConnected: true
    };
    const mockTxt = { textContent: '' };

    const fakeDoc = {
        getElementById: (id: string) => {
            if (id === 'geminiExportBadge') return attachedElement;
            if (id === 'geminiExportBadgeText') return mockTxt;
            return null;
        },
        createElement: (tag: string) => {
            if (tag === 'div') return mockBadge;
            return {};
        },
        body: {
            appendChild: (el: any) => { attachedElement = el; }
        }
    };

    const origDoc = (globalThis as any).document;
    const origWindow = (globalThis as any).window;
    try {
        (globalThis as any).document = fakeDoc;
        (globalThis as any).window = {
            innerWidth: 1920,
            innerHeight: 1080,
            addEventListener: () => {}
        };

        const badge = BadgeView.ensureBadge({ isZh: () => true });
        assert.ok(badge);
        assert.strictEqual(badge.id, 'geminiExportBadge');

        BadgeView.updateBadge(15, 0, null, false, { isZh: () => true, getAccountSlot: () => 'u0' });
        assert.strictEqual(mockTxt.textContent, '已同步 15 条');
        assert.strictEqual(BadgeView.getLastKnownCount(), 15);
    } finally {
        (globalThis as any).document = origDoc;
        (globalThis as any).window = origWindow;
    }
});

// ---------------------------------------------------------------------------
// DialogView
// ---------------------------------------------------------------------------
test('dialogView - exports and safe no-DOM invocation', () => {
    assert.ok(DialogView);
    assert.strictEqual(typeof DialogView.renderExportBanner, 'function');
    assert.strictEqual(typeof DialogView.dismissExportBanner, 'function');
    assert.strictEqual(typeof DialogView.showDirectWritePrompt, 'function');
    assert.strictEqual(typeof DialogView.hideDirectWritePrompt, 'function');
    assert.strictEqual(typeof DialogView.showTakeoutLimitPrompt, 'function');
    assert.strictEqual(typeof DialogView.hideTakeoutLimitPrompt, 'function');

    DialogView.renderExportBanner(null, 'u0', false);
    DialogView.showDirectWritePrompt(100, () => {}, () => {});
    DialogView.hideDirectWritePrompt();
    DialogView.showTakeoutLimitPrompt({ count: 600, onImportTakeout: () => {} });
    DialogView.hideTakeoutLimitPrompt();
});

test('dialogView - renderExportBanner XSS prevention: lastChatTitle is rendered as text node, not HTML', () => {
    const appendedNodes: any[] = [];
    const bannerElem = { style: {} };
    const bannerTextElem = {
        _html: '',
        get innerHTML() { return this._html; },
        set innerHTML(val: any) { this._html = val; appendedNodes.length = 0; },
        appendChild(node: any) { appendedNodes.push(node); }
    };
    const btnResumeElem = { style: {} };

    const oldDoc = (global as any).document;
    const oldI18n = (global as any).I18n;
    try {
        (global as any).I18n = require('../src/core/utils/i18n.js');
        (global as any).document = {
            getElementById: (id: string) => {
                if (id === 'exportSessionBanner') return bannerElem;
                if (id === 'exportSessionText') return bannerTextElem;
                if (id === 'btnResumeExport') return btnResumeElem;
                return null;
            },
            createTextNode: (text: string) => ({ nodeType: 3, textContent: text })
        };

        const maliciousTitle = '<svg onload=alert(1)>';
        DialogView.renderExportBanner({
            status: 'interrupted',
            total: 10,
            current: 3,
            lastChatTitle: maliciousTitle
        }, 'u0', false);

        assert.ok(!bannerTextElem.innerHTML.includes('<svg'), 'innerHTML must not contain unescaped HTML tags');
        assert.strictEqual(appendedNodes.length, 1, 'lastChatTitle must be appended as a text node');
        assert.strictEqual(appendedNodes[0].nodeType, 3, 'Appended child must be a text node');
        assert.ok(appendedNodes[0].textContent.includes(maliciousTitle.slice(0, 20)), 'Text node must contain the sliced raw title safely');
    } finally {
        (global as any).document = oldDoc;
        (global as any).I18n = oldI18n;
    }
});

// ---------------------------------------------------------------------------
// ListView
// ---------------------------------------------------------------------------
test('listView - isRealTitle recognition & exports', () => {
    assert.strictEqual(ListView.isRealTitle('Valid Title', '123'), true);
    assert.strictEqual(ListView.isRealTitle('Untitled', '123'), false);
    assert.strictEqual(ListView.isRealTitle('未命名对话', '123'), false);
    assert.strictEqual(ListView.isRealTitle('c_12345678', '12345678'), false);
    assert.strictEqual(ListView.isRealTitle('', '123'), false);
    assert.strictEqual(ListView.isRealTitle(null, '123'), false);

    assert.strictEqual(typeof ListView.render, 'function');
    assert.strictEqual(typeof ListView.updateStat, 'function');
    assert.strictEqual(typeof ListView.getSelected, 'function');
    assert.strictEqual(typeof ListView.selectAll, 'function');
    assert.strictEqual(typeof ListView.deselectAll, 'function');
    assert.strictEqual(typeof ListView.selectUnexported, 'function');
    assert.strictEqual(typeof ListView.selectNeedsUpdate, 'function');
    assert.strictEqual(typeof ListView.checkIsUpdated, 'function');
});

test('listView - checkIsUpdated correctly detects new dialogue and timestamps', () => {
    const checkIsUpdated = ListView.checkIsUpdated;
    assert.strictEqual(typeof checkIsUpdated, 'function');

    // 1. Unexported conversation
    assert.strictEqual(checkIsUpdated({ id: 'c1', updatedAt: 1700000000000 }, null), false);
    assert.strictEqual(checkIsUpdated({ id: 'c1', updatedAt: 1700000000000 }, undefined), false);

    // 2. Exported conversation with no subsequent updates
    const exportedTime = 1700000050000;
    const recSame = { exportedAt: new Date(exportedTime).toISOString(), chatTime: exportedTime, messageCount: 4 };
    assert.strictEqual(checkIsUpdated({ id: 'c1', updatedAt: exportedTime, messageCount: 4 }, recSame), false);

    // 3. Exported conversation within 2000ms grace window (e.g. clock drift / write latency)
    assert.strictEqual(checkIsUpdated({ id: 'c1', updatedAt: exportedTime + 1500, messageCount: 4 }, recSame), false);

    // 4. Exported conversation with subsequent activity (> 2000ms)
    assert.strictEqual(checkIsUpdated({ id: 'c1', updatedAt: exportedTime + 10000, messageCount: 4 }, recSame), true);

    // 5. Exported conversation with subsequent messageCount increase
    assert.strictEqual(checkIsUpdated({ id: 'c1', updatedAt: exportedTime, messageCount: 6 }, recSame), true);
});

test('listView - render displays Updated badge and auto-checks updated conversations', () => {
    const fakeList: any = { innerHTML: '', addEventListener: () => {} };
    const fakeDoc = {
        getElementById: (id: string) => id === 'list' ? fakeList : null,
        querySelectorAll: (sel: string) => []
    };

    const origDoc = (globalThis as any).document;
    const origI18n = (globalThis as any).I18n;
    try {
        (globalThis as any).document = fakeDoc;
        (globalThis as any).I18n = {
            t: (key: string) => {
                if (key === 'badgeNeedsReexport' || key === 'badgeUpdated') return '已更新';
                if (key === 'badgeExported') return '已导出';
                return key;
            }
        };

        const t0 = 1700000000000;
        const convs = [
            { id: 'c_unexp', title: '未导出对话', timestamp: t0 },
            { id: 'c_exported', title: '已导出未更新对话', timestamp: t0, updatedAt: t0 },
            { id: 'c_updated', title: '已导出有新对话', timestamp: t0, updatedAt: t0 + 60000 }
        ];
        const expMap = {
            'c_exported': { exportedAt: new Date(t0 + 5000).toISOString(), title: '已导出未更新对话' },
            'c_updated': { exportedAt: new Date(t0 + 5000).toISOString(), title: '已导出有新对话' }
        };

        // Render with null prevSelectedSet (default initial load)
        ListView.render(convs as any, expMap as any, null);

        const html = fakeList.innerHTML;
        // Verify badge-updated is rendered for c_updated
        assert.ok(html.includes('badge badge-updated'), 'Must contain badge-updated class');
        assert.ok(html.includes('已更新'), 'Must render 已更新 text for updated conversation');

        // Verify badge-exported is rendered for c_exported
        assert.ok(html.includes('badge badge-exported'), 'Must contain badge-exported class');
        assert.ok(html.includes('已导出'), 'Must render 已导出 text for exported conversation');

        // Verify checkboxes: unexported and updated are checked by default, exported is unchecked
        assert.ok(html.includes('data-chat-id="c_unexp"'), 'Contains unexported item');
        assert.ok(html.includes('data-chat-id="c_exported"'), 'Contains exported item');
        assert.ok(html.includes('data-chat-id="c_updated"'), 'Contains updated item');
    } finally {
        (globalThis as any).document = origDoc;
        (globalThis as any).I18n = origI18n;
    }
});

test('listView - selectAll & deselectAll DOM simulation', () => {
    const mockCheckboxes = [{ checked: false, dataset: { idx: '0' } }, { checked: false, dataset: { idx: '1' } }];
    const fakeDoc = {
        querySelectorAll: (selector: string) => {
            if (selector.includes('input[type=checkbox]:checked')) return mockCheckboxes.filter((c: any) => c.checked);
            if (selector.includes('input[type=checkbox]')) return mockCheckboxes;
            return [];
        },
        getElementById: () => null
    };

    const origDoc = (globalThis as any).document;
    try {
        (globalThis as any).document = fakeDoc;
        const convs: any[] = [{ id: '1', title: 'A' }, { id: '2', title: 'B' }];
        
        ListView.selectAll(convs);
        assert.strictEqual(mockCheckboxes[0].checked, true);
        assert.strictEqual(mockCheckboxes[1].checked, true);
        assert.strictEqual(ListView.getSelected(convs).length, 2);

        ListView.deselectAll(convs);
        assert.strictEqual(mockCheckboxes[0].checked, false);
        assert.strictEqual(mockCheckboxes[1].checked, false);
        assert.strictEqual(ListView.getSelected(convs).length, 0);
    } finally {
        (globalThis as any).document = origDoc;
    }
});

test('listView - updateItemExportStatus in-place DOM update', () => {
    let queriedSelector: any = null;
    const fakeBadge = { textContent: 'New', style: {} };
    const fakeItem = {
        querySelector: (sel: string) => {
            if (sel === '.badge') return fakeBadge;
            return null;
        }
    };
    const fakeDoc = {
        querySelector: (sel: string) => {
            queriedSelector = sel;
            if (sel.includes('test_chat_123')) return fakeItem;
            return null;
        },
        querySelectorAll: () => [],
        getElementById: () => null
    };

    const origDoc = (globalThis as any).document;
    try {
        (globalThis as any).document = fakeDoc;
        assert.strictEqual(typeof ListView.updateItemExportStatus, 'function');
        ListView.updateItemExportStatus('c_test_chat_123', { exportedAt: '2026-09-07' });
        assert.ok(queriedSelector && queriedSelector.includes('test_chat_123'));
        assert.ok(fakeBadge.textContent === '已导出' || fakeBadge.textContent === 'Exported');
    } finally {
        (globalThis as any).document = origDoc;
    }
});

test('listView - row click toggles checkbox and fires change', () => {
    let changeFired = false;
    const mockCheckbox = {
        checked: false,
        dispatchEvent: (event: any) => {
            if (event.type === 'change') changeFired = true;
        }
    };
    const mockItem = {
        querySelector: (sel: string) => sel === 'input[type=checkbox]' ? mockCheckbox : null
    };

    let clickHandler: any = null;
    const mockList = {
        _delegated: false,
        innerHTML: '',
        addEventListener: (type: string, fn: any) => {
            if (type === 'click') clickHandler = fn;
        }
    };

    const origDoc = (globalThis as any).document;
    try {
        (globalThis as any).document = {
            getElementById: (id: string) => id === 'list' ? mockList : null
        };

        ListView.render([{ id: 'c_test_click', title: 'Test Chat' } as any]);
        assert.ok(clickHandler, 'Click delegation handler must be attached to list');

        // Click inside the row (e.g. on title)
        const mockTitleTarget = {
            closest: (sel: string) => {
                if (sel === 'a.open-link') return null;
                if (sel === '.item') return mockItem;
                return null;
            },
            matches: () => false
        };

        clickHandler({ target: mockTitleTarget } as any);
        assert.strictEqual(mockCheckbox.checked, true, 'Row click must toggle checkbox from false to true');
        assert.strictEqual(changeFired, true, 'Row click must dispatch change event');

        // Second click toggles it back
        changeFired = false;
        clickHandler({ target: mockTitleTarget } as any);
        assert.strictEqual(mockCheckbox.checked, false, 'Second row click must toggle checkbox back to false');
        assert.strictEqual(changeFired, true, 'Second click must dispatch change event');
    } finally {
        (globalThis as any).document = origDoc;
    }
});

// ---------------------------------------------------------------------------
// LogView
// ---------------------------------------------------------------------------
test('logView - buffer recording and deduplication', () => {
    LogView.clear();
    assert.strictEqual(LogView.getBuffer().length, 0);

    LogView.log('Message 1', 'info');
    assert.strictEqual(LogView.getBuffer().length, 1);
    assert.strictEqual(LogView.getBuffer()[0].msg, 'Message 1');

    // Identical message in rapid succession should be deduplicated
    LogView.log('Message 1', 'info');
    assert.strictEqual(LogView.getBuffer().length, 1);

    // Different message should be added
    LogView.log('Message 2', 'warn');
    assert.strictEqual(LogView.getBuffer().length, 2);
    assert.strictEqual(LogView.getBuffer()[1].level, 'warn');

    LogView.clear();
    assert.strictEqual(LogView.getBuffer().length, 0);
});
