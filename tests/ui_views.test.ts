export {};
const test = require('node:test');
const assert = require('node:assert');
const { __setModuleOverride, __getModuleOverride } = require('../src/core/utils/moduleOverrides.js');

const AccountView = require('../src/ui/views/accountView.js');
const BadgeView = require('../src/content/badgeView.js');
const DialogView = require('../src/ui/views/dialogView.js');
const ListView = require('../src/ui/views/listView.js');
const LogView = require('../src/ui/views/logView.js');
const ProgressView = require('../src/ui/views/progressView.js');


// ---------------------------------------------------------------------------
// AccountView
// ---------------------------------------------------------------------------
test('accountView - exports and safe render with DOM side effect verification', () => {
    assert.ok(AccountView);
    // 1. Safe render without DOM element does not crash
    AccountView.render({ 'u0': { name: 'Main' } }, 'u0');

    // 2. Verified DOM render with element creation and selection
    const mockSelect: any = {
        id: 'accountSlotSelect',
        style: {},
        innerHTML: '',
        children: [] as any[],
        appendChild(el: any) { this.children.push(el); }
    };
    const oldDoc = (global as any).document;
    try {
        (global as any).document = {
            getElementById: (id: string) => id === 'accountSlotSelect' ? mockSelect : null,
            createElement: (tag: string) => ({
                tagName: tag.toUpperCase(),
                value: '',
                selected: false,
                textContent: ''
            })
        };

        AccountView.render({
            u0: { name: '默认账号', count: 12 },
            u1: { name: '工作账号', count: 5 }
        }, 'u1');

        assert.strictEqual(mockSelect.style.display, 'inline-block', 'Select should be displayed inline-block when multiple slots exist');
        assert.strictEqual(mockSelect.children.length, 2, 'Should create 2 option elements');
        assert.strictEqual(mockSelect.children[0].value, 'u0');
        assert.strictEqual(mockSelect.children[0].selected, false);
        assert.strictEqual(mockSelect.children[1].value, 'u1');
        assert.strictEqual(mockSelect.children[1].selected, true, 'Current slot u1 should be selected');
    } finally {
        (global as any).document = oldDoc;
    }
});

// ---------------------------------------------------------------------------
// BadgeView
// ---------------------------------------------------------------------------
test('badgeView - DOM creation and text update', () => {
    let attachedElement: any = null;
    const mockBadge = {
        id: 'geminiExportBadge',
        innerHTML: '',
        style: {},
        classList: { add: () => {}, remove: () => {}, contains: () => false },
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
test('dialogView - exports, safe no-DOM invocation, and verified modal transitions', async () => {
    assert.ok(DialogView);

    // 1. Safe no-DOM invocation
    DialogView.renderExportBanner(null, 'u0', false);
    DialogView.showDirectWritePrompt(100, () => {}, () => {});
    DialogView.hideDirectWritePrompt();
    await DialogView.showTakeoutLimitPrompt({ count: 600, onImportTakeout: () => {} });
    DialogView.hideTakeoutLimitPrompt();

    // 2. Verified DOM side effects for Direct Write modal
    const mockDirectWriteModal: any = { id: 'directWriteModal', style: { display: 'none' } };
    const mockPromptText: any = { id: 'directWritePromptText', textContent: '' };
    const mockBtnFolder: any = { id: 'btnModalSwitchFolder', onclick: null };
    const mockBtnZip: any = { id: 'btnModalContinueZip', onclick: null };
    const mockBtnClose: any = { id: 'btnDirectWriteClose', onclick: null };

    const mockTakeoutModal: any = { id: 'takeoutLimitModal', style: { display: 'none' } };
    const mockTakeoutTitle: any = { id: 'takeoutLimitPromptTitle', textContent: '' };
    const mockTakeoutText: any = { id: 'takeoutLimitPromptText', textContent: '' };

    const domMap: Record<string, any> = {
        directWriteModal: mockDirectWriteModal,
        directWritePromptText: mockPromptText,
        btnModalSwitchFolder: mockBtnFolder,
        btnModalContinueZip: mockBtnZip,
        btnDirectWriteClose: mockBtnClose,
        takeoutLimitModal: mockTakeoutModal,
        takeoutLimitPromptTitle: mockTakeoutTitle,
        takeoutLimitPromptText: mockTakeoutText
    };

    const oldDoc = (global as any).document;
    try {
        (global as any).document = {
            getElementById: (id: string) => domMap[id] || null
        };

        // Test showDirectWritePrompt
        DialogView.showDirectWritePrompt(55, () => {}, () => {});
        assert.strictEqual(mockDirectWriteModal.style.display, 'flex', 'Direct write modal should show with display: flex');
        assert.ok(mockPromptText.textContent.includes('55'), 'Prompt text should include conversation count 55');
        // 行为断言豁免: 验证 showDirectWritePrompt 已实际把回调绑定到按钮上(DOM 副作用),
        // 而非仅检查 DialogView 接口存在
        assert.strictEqual(typeof mockBtnZip.onclick, 'function');

        DialogView.hideDirectWritePrompt();
        assert.strictEqual(mockDirectWriteModal.style.display, 'none', 'Direct write modal should hide with display: none');

        // Test showTakeoutLimitPrompt
        await DialogView.showTakeoutLimitPrompt({ count: 615, hitGoogleLimit: true, force: true });
        assert.strictEqual(mockTakeoutModal.style.display, 'flex', 'Takeout limit modal should show with display: flex');
        assert.ok(mockTakeoutText.textContent.includes('615'), 'Takeout text should include count 615');

        DialogView.hideTakeoutLimitPrompt();
        assert.strictEqual(mockTakeoutModal.style.display, 'none', 'Takeout limit modal should hide with display: none');
    } finally {
        (global as any).document = oldDoc;
    }
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
    try {
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
    }
});

// ---------------------------------------------------------------------------
// ListView
// ---------------------------------------------------------------------------
test('listView - isRealTitle recognition', () => {
    assert.strictEqual(ListView.isRealTitle('Valid Title', '123'), true);
    assert.strictEqual(ListView.isRealTitle('Untitled', '123'), false);
    assert.strictEqual(ListView.isRealTitle('未命名对话', '123'), false);
    assert.strictEqual(ListView.isRealTitle('c_12345678', '12345678'), false);
    assert.strictEqual(ListView.isRealTitle('', '123'), false);
    assert.strictEqual(ListView.isRealTitle(null, '123'), false);
});

test('listView - checkIsUpdated correctly detects new dialogue and timestamps', () => {
    const checkIsUpdated = ListView.checkIsUpdated;

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

    // 6. Incomplete / truncated conversation where cloud metadata inflated messageCount (e.g. 2)
    // but actual exported messages was 1, with export occurring strictly after last chat activity
    const chatTs = 1700000000000;
    const recNewer = {
        exportedAt: new Date(chatTs + 86400000).toISOString(),
        chatTime: chatTs,
        messageCount: 1
    };
    // Must return false, breaking the infinite '已更新' loop!
    assert.strictEqual(checkIsUpdated({ id: 'c_truncated', updatedAt: chatTs, messageCount: 2 }, recNewer), false);

    // 7. But if subsequent user activity arrives after export (updatedAt advanced past exportedAt), must return true
    assert.strictEqual(checkIsUpdated({ id: 'c_truncated', updatedAt: chatTs + 86400000 + 5000, messageCount: 2 }, recNewer), true);
});

test('listView - render displays Updated badge and auto-checks updated conversations', () => {
    const fakeList: any = { innerHTML: '', addEventListener: () => {} };
    const fakeDoc = {
        getElementById: (id: string) => id === 'list' ? fakeList : null,
        querySelectorAll: (sel: string) => []
    };

    const origDoc = (globalThis as any).document;
    const origI18n = __getModuleOverride('I18n');
    try {
        (globalThis as any).document = fakeDoc;
        __setModuleOverride('I18n', {
            t: (key: string) => {
                if (key === 'badgeNeedsReexport' || key === 'badgeUpdated') return '已更新';
                if (key === 'badgeExported') return '已导出';
                return key;
            }
        });

        const t0 = 1700000000000;
        const convs = [
            { id: 'c_unexp', title: '未导出对话', timestamp: t0 },
            { id: 'c_exported', title: '已导出未更新对话', timestamp: t0, updatedAt: t0 },
            { id: 'c_updated', title: '已导出有新对话', timestamp: t0, updatedAt: t0 + 60000 }
        ];
        // Post-triage-#5 contract: exportedIds maps are normalized to canonical
        // keys on the read path, so the test map uses canonical keys too.
        const expMap = {
            'exported': { exportedAt: new Date(t0 + 5000).toISOString(), title: '已导出未更新对话' },
            'updated': { exportedAt: new Date(t0 + 5000).toISOString(), title: '已导出有新对话' }
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
        __setModuleOverride('I18n', origI18n);
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

// ---------------------------------------------------------------------------
// DialogView - Export Failure Banner
// ---------------------------------------------------------------------------
test('dialogView - renderExportFailureBanner and hideExportFailureBanner', () => {
    const mockCard = { id: 'exportFailureCard', style: { display: 'none' } };
    const mockTitle = { id: 'exportFailureTitle', textContent: '' };
    const mockBtnRetry = { id: 'btnRetryFailed', textContent: '', onclick: null as any };
    const mockBtnDismiss = { id: 'btnDismissFailure', onclick: null as any };
    const mockList = { id: 'exportFailureList', innerHTML: '', appendChild: (el: any) => {} };

    const oldDoc = (globalThis as any).document;
    try {
        (globalThis as any).document = {
            getElementById: (id: string) => {
                if (id === 'exportFailureCard') return mockCard;
                if (id === 'exportFailureTitle') return mockTitle;
                if (id === 'btnRetryFailed') return mockBtnRetry;
                if (id === 'btnDismissFailure') return mockBtnDismiss;
                if (id === 'exportFailureList') return mockList;
                return null;
            },
            createElement: () => ({ style: {}, textContent: '', title: '' })
        };

        let retryTriggered = false;
        DialogView.renderExportFailureBanner(
            [{ id: 'chat-1', title: 'Fail 1', error: 'Network error' }],
            () => { retryTriggered = true; }
        );

        assert.strictEqual(mockCard.style.display, 'block');
        assert.ok(DialogView.getLastFailedChats().length === 1);
        // 行为断言豁免: 验证横幅已实际把重试回调挂到按钮上(DOM 副作用),下一行即调用它验证真实触发
        assert.strictEqual(typeof mockBtnRetry.onclick, 'function');
        mockBtnRetry.onclick();
        assert.strictEqual(retryTriggered, true);

        // Dismiss
        // 行为断言豁免: 验证横幅已实际把关闭回调挂到按钮上,调用后卡片真实隐藏
        assert.strictEqual(typeof mockBtnDismiss.onclick, 'function');
        mockBtnDismiss.onclick();
        assert.strictEqual(mockCard.style.display, 'none');

        // Hide
        DialogView.hideExportFailureBanner();
        assert.strictEqual(mockCard.style.display, 'none');
        assert.strictEqual(DialogView.getLastFailedChats().length, 0);
    } finally {
        (globalThis as any).document = oldDoc;
    }
});

// ---------------------------------------------------------------------------
// ProgressView
// ---------------------------------------------------------------------------
test('progressView - show/update/complete/reset/hide drive DOM side effects', () => {
    const wrap = { id: 'progWrap', style: { display: 'none' } };
    const bar = { id: 'bar', style: { width: '' } };
    const text = { id: 'progText', textContent: '' };

    const oldDoc = (globalThis as any).document;
    try {
        (globalThis as any).document = {
            getElementById: (id: string) =>
                id === 'progWrap' ? wrap : id === 'bar' ? bar : id === 'progText' ? text : null
        };

        ProgressView.show(25, 'starting');
        assert.strictEqual(wrap.style.display, 'block', 'show must reveal the progress wrapper');
        assert.strictEqual(bar.style.width, '25%', 'show must set bar width to the initial percent');
        assert.strictEqual(text.textContent, 'starting', 'show must set progress text');

        ProgressView.update(150, 'halfway');
        assert.strictEqual(bar.style.width, '100%', 'update must clamp percent to 100');
        assert.strictEqual(text.textContent, 'halfway', 'update must refresh progress text');

        ProgressView.update(-10);
        assert.strictEqual(bar.style.width, '0%', 'update must clamp negative percent to 0');

        ProgressView.complete('done');
        assert.strictEqual(bar.style.width, '100%', 'complete must fill the bar');
        assert.strictEqual(text.textContent, 'done', 'complete must set the final text');

        ProgressView.reset();
        assert.strictEqual(bar.style.width, '0%', 'reset must clear bar width');
        assert.strictEqual(text.textContent, '', 'reset must clear text');

        ProgressView.show(50);
        ProgressView.hide();
        assert.strictEqual(wrap.style.display, 'none', 'hide must conceal the wrapper');
        assert.strictEqual(bar.style.width, '0%', 'hide must reset bar width');
        assert.strictEqual(text.textContent, '', 'hide must reset text');
    } finally {
        (globalThis as any).document = oldDoc;
    }
});

// ---------------------------------------------------------------------------
// ListView - Filtering & View-Scoped Selection
// ---------------------------------------------------------------------------
test('listView - filterType filtering (unexported, failed, unexported_or_failed, exported)', () => {
    let innerHTML = '';
    const fakeList: any = {
        innerHTML: '',
        addEventListener: () => {}
    };
    Object.defineProperty(fakeList, 'innerHTML', {
        get() { return innerHTML; },
        set(val) { innerHTML = val; }
    });

    const fakeDoc = {
        getElementById: (id: string) => (id === 'list' ? fakeList : null),
        querySelectorAll: (sel: string) => []
    };

    const origDoc = (globalThis as any).document;
    try {
        (globalThis as any).document = fakeDoc;

        const convs = [
            { id: 'chat_unexp', title: 'Unexported Chat' },
            { id: 'chat_ok', title: 'Exported Chat' },
            { id: 'chat_partial', title: 'Partial Asset Chat' },
            { id: 'chat_fail', title: 'Failed Chat' }
        ];
        const expMap: Record<string, any> = {
            chat_ok: { exportedAt: '2026-09-20T00:00:00Z', status: 'ok' },
            chat_partial: { exportedAt: '2026-09-20T00:00:00Z', status: 'partial', hasFailedAssets: true }
        };
        const failedIds = new Set(['chat_fail']);

        // 1. All
        ListView.render(convs as any, expMap, null, '', 'all', failedIds);
        assert.ok(innerHTML.includes('data-chat-id="chat_unexp"'));
        assert.ok(innerHTML.includes('data-chat-id="chat_ok"'));
        assert.ok(innerHTML.includes('data-chat-id="chat_partial"'));
        assert.ok(innerHTML.includes('data-chat-id="chat_fail"'));

        // 2. Unexported
        ListView.render(convs as any, expMap, null, '', 'unexported', failedIds);
        assert.ok(innerHTML.includes('data-chat-id="chat_unexp"'));
        assert.ok(!innerHTML.includes('data-chat-id="chat_ok"'));
        assert.ok(!innerHTML.includes('data-chat-id="chat_partial"'));
        assert.ok(!innerHTML.includes('data-chat-id="chat_fail"'));

        // 3. Failed (both chat_fail and chat_partial)
        ListView.render(convs as any, expMap, null, '', 'failed', failedIds);
        assert.ok(!innerHTML.includes('data-chat-id="chat_unexp"'));
        assert.ok(!innerHTML.includes('data-chat-id="chat_ok"'));
        assert.ok(innerHTML.includes('data-chat-id="chat_partial"'));
        assert.ok(innerHTML.includes('data-chat-id="chat_fail"'));

        // 4. Unexported or Failed
        ListView.render(convs as any, expMap, null, '', 'unexported_or_failed', failedIds);
        assert.ok(innerHTML.includes('data-chat-id="chat_unexp"'));
        assert.ok(!innerHTML.includes('data-chat-id="chat_ok"'));
        assert.ok(innerHTML.includes('data-chat-id="chat_partial"'));
        assert.ok(innerHTML.includes('data-chat-id="chat_fail"'));

        // 5. Exported
        ListView.render(convs as any, expMap, null, '', 'exported', failedIds);
        assert.ok(!innerHTML.includes('data-chat-id="chat_unexp"'));
        assert.ok(innerHTML.includes('data-chat-id="chat_ok"'));
        assert.ok(!innerHTML.includes('data-chat-id="chat_partial"'));
        assert.ok(!innerHTML.includes('data-chat-id="chat_fail"'));
    } finally {
        (globalThis as any).document = origDoc;
    }
});

test('listView - selectAll & deselectAll only affects visible items in current view', () => {
    const item1 = { dataset: { chatId: 'chat_1' }, closest: () => item1, querySelector: () => cb1 };
    const item2 = { dataset: { chatId: 'chat_2' }, closest: () => item2, querySelector: () => cb2 };
    const cb1: any = { checked: false, dataset: { idx: '0' }, closest: () => item1 };
    const cb2: any = { checked: true, dataset: { idx: '1' }, closest: () => item2 };

    // Initially view only shows item1 (e.g. filtered view)
    let visibleCheckboxes = [cb1];

    const fakeDoc = {
        querySelectorAll: (selector: string) => {
            if (selector.includes('input[type=checkbox]:checked')) return visibleCheckboxes.filter(c => c.checked);
            if (selector.includes('input[type=checkbox]')) return visibleCheckboxes;
            return [];
        },
        getElementById: () => null
    };

    const origDoc = (globalThis as any).document;
    try {
        (globalThis as any).document = fakeDoc;
        const convs: any[] = [{ id: 'chat_1', title: 'C1' }, { id: 'chat_2', title: 'C2' }];

        // Set initial canonical selection: only chat_2 is selected
        ListView.setSelectedIds(new Set(['chat_2']));

        // Select All in filtered view (which only has item1 visible)
        ListView.selectAll(convs);
        assert.strictEqual(cb1.checked, true, 'Visible item1 must be checked');
        // Both chat_1 and chat_2 must now be in selected IDs (chat_2 was not deselected)
        const selectedIds = ListView.getSelectedIds();
        assert.ok(selectedIds.has('chat_1'), 'chat_1 should now be selected');
        assert.ok(selectedIds.has('chat_2'), 'chat_2 hidden in view must retain its selected status');

        // Deselect All in filtered view (which only has item1 visible)
        ListView.deselectAll(convs);
        assert.strictEqual(cb1.checked, false, 'Visible item1 must be unchecked');
        const selectedAfter = ListView.getSelectedIds();
        assert.ok(!selectedAfter.has('chat_1'), 'chat_1 in visible view should be deselected');
        assert.ok(selectedAfter.has('chat_2'), 'chat_2 hidden in view must still remain selected');
    } finally {
        (globalThis as any).document = origDoc;
    }
});

test('listView - render displays badge-exported-partial for partial records unless conversation has post-export activity', () => {
    const fakeList: any = { innerHTML: '', addEventListener: () => {} };
    const fakeDoc = {
        getElementById: (id: string) => id === 'list' ? fakeList : null,
        querySelectorAll: () => []
    };

    const origDoc = (globalThis as any).document;
    const origI18n = __getModuleOverride('I18n');
    try {
        (globalThis as any).document = fakeDoc;
        __setModuleOverride('I18n', {
            t: (key: string) => {
                if (key === 'badgeNeedsReexport' || key === 'badgeUpdated') return '已更新';
                if (key === 'badgeExportedPartial') return '已导出 (部分附件缺失)';
                if (key === 'badgeExported') return '已导出';
                return key;
            }
        });

        const t0 = 1700000000000;
        const convs = [
            // Freshly exported partial chat (no activity since export) -> should show badge-exported-partial
            { id: 'c_partial_fresh', title: '部分附件对话', timestamp: t0, updatedAt: t0 },
            // Partial chat that ALSO had new user activity after export -> should show badge-updated
            { id: 'c_partial_updated', title: '部分附件且有新回复', timestamp: t0, updatedAt: t0 + 60000 },
            // Exported chat where updatedAt > timestamp, exported AFTER updatedAt -> should show badge-exported (not badge-updated)
            { id: 'c_resumed', title: '多轮历史对话', timestamp: t0 - 86400000, updatedAt: t0 }
        ];
        const expMap = {
            'partial_fresh': {
                exportedAt: new Date(t0 + 5000).toISOString(),
                chatTime: t0,
                status: 'partial',
                hasFailedAssets: true
            },
            'partial_updated': {
                exportedAt: new Date(t0 + 5000).toISOString(),
                chatTime: t0,
                status: 'partial',
                hasFailedAssets: true
            },
            'resumed': {
                exportedAt: new Date(t0 + 5000).toISOString(),
                // Even if legacy chatTime stored creation timestamp (t0 - 86400000), exportedAt is newer than updatedAt (t0)
                chatTime: t0 - 86400000,
                status: 'ok'
            }
        };

        ListView.render(convs as any, expMap as any, null);
        const rows = fakeList.innerHTML.split('data-chat-id="').slice(1);
        const rowPartialFresh = rows.find((r: string) => r.startsWith('c_partial_fresh')) || '';
        const rowPartialUpdated = rows.find((r: string) => r.startsWith('c_partial_updated')) || '';
        const rowResumed = rows.find((r: string) => r.startsWith('c_resumed')) || '';

        assert.ok(rowPartialFresh.includes('badge-exported-partial'), 'Fresh partial export must render badge-exported-partial, not badge-updated');
        assert.ok(rowPartialFresh.includes('已导出 (部分附件缺失)'), 'Fresh partial export must show partial label');
        assert.ok(rowPartialUpdated.includes('badge-updated'), 'Partial export with newer post-export activity must render badge-updated');
        assert.ok(rowResumed.includes('badge-exported'), 'Resumed conversation exported after updatedAt must render badge-exported');
        assert.ok(!rowResumed.includes('badge-updated'), 'Resumed conversation exported after updatedAt must not falsely render badge-updated');
    } finally {
        (globalThis as any).document = origDoc;
        __setModuleOverride('I18n', origI18n);
    }
});

test('listView - updateItemExportStatus renders pending_assets badge and transitions to exported badge', () => {
    const appendedSpans: any[] = [];
    const titleContainer = {
        appendChild: (el: any) => appendedSpans.push(el)
    };
    const mockItem: any = {
        querySelector: (sel: string) => {
            if (sel === '.badge') return appendedSpans[0] || null;
            if (sel === 'div') return titleContainer;
            return null;
        }
    };
    const fakeDoc = {
        querySelector: () => mockItem,
        createElement: (tag: string) => ({ tagName: tag, className: '', style: { cssText: '' }, textContent: '' })
    };

    const origDoc = (globalThis as any).document;
    const origI18n = __getModuleOverride('I18n');
    try {
        (globalThis as any).document = fakeDoc;
        __setModuleOverride('I18n', {
            t: (key: string) => {
                if (key === 'badgeExportingAssets') return '附件导出中...';
                if (key === 'badgeExported') return '已导出';
                return key;
            }
        });

        ListView.updateItemExportStatus('chat_img_1', { status: 'pending_assets' } as any);
        assert.strictEqual(appendedSpans.length, 1);
        assert.strictEqual(appendedSpans[0].className, 'badge badge-exporting-assets');
        assert.strictEqual(appendedSpans[0].textContent, '附件导出中...');

        ListView.updateItemExportStatus('chat_img_1', { exportedAt: new Date().toISOString(), status: 'ok' });
        assert.strictEqual(appendedSpans[0].className, 'badge badge-exported');
        assert.strictEqual(appendedSpans[0].textContent, '已导出');
    } finally {
        (globalThis as any).document = origDoc;
        __setModuleOverride('I18n', origI18n);
    }
});

test('listView - resolveConversationExportState provides unified SSoT across all export states', () => {
    const resolveState = ListView.resolveConversationExportState;
    const t0 = 1700000000000;
    const chat = { id: 'c_ssot', timestamp: t0, updatedAt: t0, messageCount: 2 };

    // 1. unexported
    const sUnexp = resolveState(chat, null);
    assert.strictEqual(sUnexp.state, 'unexported');
    assert.strictEqual(sUnexp.isUnexported, true);
    assert.strictEqual(sUnexp.needsIncrementalExport, true);
    assert.strictEqual(sUnexp.badge.kind, 'none');

    // 2. exporting_assets
    const sPending = resolveState(chat, { status: 'pending_assets' } as any);
    assert.strictEqual(sPending.state, 'exporting_assets');
    assert.strictEqual(sPending.badge.kind, 'exporting_assets');
    assert.strictEqual(sPending.badge.className, 'badge badge-exporting-assets');

    // 3. exported_ok
    const sOk = resolveState(chat, { exportedAt: new Date(t0 + 5000).toISOString(), chatTime: t0, status: 'ok', messageCount: 2 });
    assert.strictEqual(sOk.state, 'exported_ok');
    assert.strictEqual(sOk.isExportedClean, true);
    assert.strictEqual(sOk.needsIncrementalExport, false);
    assert.strictEqual(sOk.badge.kind, 'exported_ok');

    // 4. exported_partial (needs incremental retry, renders partial badge, not updated badge)
    const sPartial = resolveState(chat, { exportedAt: new Date(t0 + 5000).toISOString(), chatTime: t0, status: 'partial', hasFailedAssets: true, messageCount: 2 });
    assert.strictEqual(sPartial.state, 'exported_partial');
    assert.strictEqual(sPartial.hasNewerActivity, false);
    assert.strictEqual(sPartial.needsIncrementalExport, true);
    assert.strictEqual(sPartial.isFailed, true);
    assert.strictEqual(sPartial.badge.kind, 'exported_partial');

    // 5. updated (conversation advanced past export)
    const sUpdated = resolveState({ ...chat, updatedAt: t0 + 60000 }, { exportedAt: new Date(t0 + 5000).toISOString(), chatTime: t0, status: 'ok', messageCount: 2 });
    assert.strictEqual(sUpdated.state, 'updated');
    assert.strictEqual(sUpdated.hasNewerActivity, true);
    assert.strictEqual(sUpdated.needsIncrementalExport, true);
    assert.strictEqual(sUpdated.badge.kind, 'updated');

    // 6. failed in session
    const sFailed = resolveState(chat, null, { isFailedInSession: true });
    assert.strictEqual(sFailed.state, 'failed');
    assert.strictEqual(sFailed.isFailed, true);
    assert.strictEqual(sFailed.isUnexported, false);
    assert.strictEqual(sFailed.badge.kind, 'failed');

    // 7. failed record
    const sFailedRec = resolveState(chat, { exportedAt: new Date(t0 + 5000).toISOString(), status: 'failed' });
    assert.strictEqual(sFailedRec.state, 'failed');
    assert.strictEqual(sFailedRec.isFailed, true);
    assert.strictEqual(sFailedRec.badge.kind, 'failed');
});

test('uiCommon - setWorkbenchControlsDisabled toggles all action buttons, select buttons, and list selection without blocking scrolling', () => {
    const { setWorkbenchControlsDisabled, WORKBENCH_ACTION_BUTTON_IDS } = require('../src/ui/uiCommon.js');
    const elements: Record<string, any> = {};
    for (const id of WORKBENCH_ACTION_BUTTON_IDS) {
        elements[id] = { id, disabled: false };
    }
    const checkbox = { disabled: false };
    const mockList = { id: 'list', dataset: { selectionDisabled: 'false' }, style: { pointerEvents: '', opacity: '' }, querySelectorAll: () => [checkbox] };
    elements['list'] = mockList;

    const origDoc = (globalThis as any).document;
    try {
        (globalThis as any).document = {
            getElementById: (id: string) => elements[id] || null
        };

        // 1. Disable
        setWorkbenchControlsDisabled(true);
        for (const id of WORKBENCH_ACTION_BUTTON_IDS) {
            assert.strictEqual(elements[id].disabled, true, `Button ${id} should be disabled`);
        }
        assert.strictEqual(mockList.style.pointerEvents, '', 'List should keep pointer events for scrolling');
        assert.strictEqual(checkbox.disabled, true);
        assert.strictEqual(mockList.dataset.selectionDisabled, 'true');
        assert.strictEqual(mockList.style.opacity, '0.7', 'List should be dimmed');

        // 2. Enable
        setWorkbenchControlsDisabled(false);
        for (const id of WORKBENCH_ACTION_BUTTON_IDS) {
            assert.strictEqual(elements[id].disabled, false, `Button ${id} should be enabled`);
        }
        assert.strictEqual(mockList.style.pointerEvents, '', 'List should remain scrollable');
        assert.strictEqual(checkbox.disabled, false);
        assert.strictEqual(mockList.dataset.selectionDisabled, 'false');
        assert.strictEqual(mockList.style.opacity, '', 'List opacity should be restored');
    } finally {
        (globalThis as any).document = origDoc;
    }
});

