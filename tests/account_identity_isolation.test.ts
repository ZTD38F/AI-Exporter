import { useIndexStorage } from './helpers/indexStorage.js';
import { putAccount } from '../src/l3a/storageService.js';
useIndexStorage({ seedAccounts: false });
import { ConversationViewState } from '../src/ui/options/state/conversationsStore.js';
import { mount, A, B } from './helpers/uiPortHarness.js';
import { chromium } from 'playwright';
import { withRegistry } from './helpers/registryMock.js';
import { bindTabAccounts } from './helpers/tabAccounts.js';
export {};
const test = require('node:test');
const assert = require('node:assert');
test.beforeEach(async () => {
    for (const [suffix, subject] of [['1', '10000000001'], ['2', '10000000002'], ['3', '10000000003']])
        await putAccount({ id: '10000000-0000-4000-8000-00000000000' + suffix, providerId: 'gemini', providerAccountId: subject });
});


const {
    extractEmailFromText,
    extractNameFromLabel,
    sniffUserProfileFromDom
} = require('../src/l1/parsers/gemini/dom/accountSniffer.js');

const { resolveCred } = require('../src/l1/client/gemini/api/credentialManager.js');
const TabService = require('../src/runtime/capabilities/tabService.js');
const ConversationsStore = require('../src/ui/options/state/conversationsStore.js');


// 1. Account Sniffer Tests
test('accountSniffer - extractEmailFromText', () => {
    assert.strictEqual(extractEmailFromText('test.user+tag@gmail.com'), 'test.user+tag@gmail.com');
    assert.strictEqual(extractEmailFromText('Google Account: Alice (ALICE@GMAIL.COM)'), 'alice@gmail.com');
    assert.strictEqual(extractEmailFromText('no-email-here'), null);
    assert.strictEqual(extractEmailFromText(null), null);
    assert.strictEqual(extractEmailFromText(''), null);
});

test('accountSniffer - extractNameFromLabel', () => {
    assert.strictEqual(
        extractNameFromLabel('Google Account: John Doe (john@gmail.com)', 'john@gmail.com'),
        'John Doe'
    );
    assert.strictEqual(
        extractNameFromLabel('Google 帐号：张三 (zhangsan@gmail.com)', 'zhangsan@gmail.com'),
        '张三'
    );
    assert.strictEqual(
        extractNameFromLabel('Alice Smith\nalice@example.com', 'alice@example.com'),
        'Alice Smith'
    );
    assert.strictEqual(
        extractNameFromLabel('Bob Ross - bob@example.com', 'bob@example.com'),
        'Bob Ross'
    );
});

test('accountSniffer - sniffUserProfileFromDom DOM and global context', () => {
    // A: DOM button with aria-label
    const mockDoc1 = {
        querySelectorAll: (selector: string) => [
            {
                getAttribute: (attr: string) => {
                    if (attr === 'aria-label') return 'Google Account: Alice Wonderland (alice@example.com)';
                    return null;
                }
            }
        ],
        defaultView: {}
    } as any;

    const profile1 = sniffUserProfileFromDom(mockDoc1);
    assert.ok(profile1);
    assert.strictEqual(profile1?.email, 'alice@example.com');
    assert.strictEqual(profile1?.name, 'Alice Wonderland');
    assert.strictEqual(profile1?.email, 'alice@example.com');

    // B: DOM element with data-email attribute
    const mockDoc2 = {
        querySelectorAll: (selector: string) => [
            {
                getAttribute: (attr: string) => {
                    if (attr === 'data-email') return 'bob@corp.com';
                    return null;
                }
            }
        ],
        defaultView: {}
    } as any;

    const profile2 = sniffUserProfileFromDom(mockDoc2);
    assert.ok(profile2);
    assert.strictEqual(profile2?.email, 'bob@corp.com');
    assert.strictEqual(profile2?.name, undefined);
    assert.strictEqual(profile2?.email, 'bob@corp.com');

    // C: Gaia ID from window._WIZ_global_data
    const mockDoc3 = {
        querySelectorAll: () => [],
        defaultView: {
            _WIZ_global_data: {
                qDCSke: '10987654321'
            }
        }
    } as any;

    const profile3 = sniffUserProfileFromDom(mockDoc3);
    assert.ok(profile3);
    assert.strictEqual(profile3?.gaiaId, '10987654321');
    assert.strictEqual(profile3?.email, undefined);

    // D: Empty doc returns null
    const mockDoc4 = {
        querySelectorAll: () => [],
        defaultView: {}
    } as any;
    assert.strictEqual(sniffUserProfileFromDom(mockDoc4), null);
});

// 2. Credential Isolation Tests
test('credentialManager - resolveCred prevents cross-account token theft', async () => {
    const origChrome = (global as any).chrome;
    try {
        const credMap = {
            sid_u0: {
                sid: 'sid_u0',
                at: 'SECRET_TOKEN_U0',
                accountSlot: 'u0',
                lastUsed: 1000
            }
        };

        (global as any).chrome = {
            storage: {
                session: {
                    get: async () => ({ gemini_credentials_map: credMap }),
                    set: async () => {}
                },
                local: {
                    get: async () => ({ gemini_credentials_map: credMap }),
                    set: async () => {}
                }
            }
        };

        // When u1 credentials do not exist, resolveCred for u1 MUST NOT return SECRET_TOKEN_U0!
        const resultU1 = await resolveCred(null, { accountSlot: 'u1' });
        assert.strictEqual(resultU1.accountSlot, 'u1');
        assert.strictEqual(resultU1.at, '', 'Must not leak u0 token to u1');

        // When u0 credentials exist, resolving for u0 returns the u0 token
        const resultU0 = await resolveCred(null, { accountSlot: 'u0' });
        assert.strictEqual(resultU0.accountSlot, 'u0');
        assert.strictEqual(resultU0.at, 'SECRET_TOKEN_U0');
    } finally {
        (global as any).chrome = origChrome;
    }
});

// 3. Strict Tab Routing Tests
test('tabService - resolveAccountTab and sendToGeminiTab enforce strict slot matching', async () => {
    const origChrome = (global as any).chrome;
    try {
        const mockTabs = [
            { id: 101, url: 'https://gemini.google.com/u/0/app', active: true },
            { id: 102, url: 'https://gemini.google.com/u/1/app', active: false }
        ];

        (global as any).chrome = {
            tabs: {
                query: async (q: any) => mockTabs,
                sendMessage: (tabId: number, msg: any, cb: (res: any) => void) => {
                    cb({ ok: true, tabId, receivedMsg: msg });
                }
            },
            runtime: {}
        };

        Object.assign(chrome, withRegistry(chrome));
        bindTabAccounts({101: '10000000-0000-4000-8000-000000000001', 102: '10000000-0000-4000-8000-000000000002'});
        // resolveAccountTab('10000000-0000-4000-8000-000000000001') returns tab 101
        const tabU0 = await TabService.resolveAccountTab('10000000-0000-4000-8000-000000000001');
        assert.strictEqual(tabU0?.id, 101);

        // resolveAccountTab('10000000-0000-4000-8000-000000000002') returns tab 102
        const tabU1 = await TabService.resolveAccountTab('10000000-0000-4000-8000-000000000002');
        assert.strictEqual(tabU1?.id, 102);

        // resolveAccountTab rejects when no tab matches this account
        await assert.rejects(TabService.resolveAccountTab('10000000-0000-4000-8000-000000000003'), /No open Provider Tab matches this Account/);

        // sendToGeminiTab('10000000-0000-4000-8000-000000000002') sends message to tab 102
        const resU1 = await TabService.sendToGeminiTab({ action: 'ping' }, '10000000-0000-4000-8000-000000000002');
        assert.strictEqual(resU1.tabId, 102);

        // sendToGeminiTab('10000000-0000-4000-8000-000000000003') throws error instead of silently targeting u0 or u1
        await assert.rejects(
            async () => {
                await TabService.sendToGeminiTab({ action: 'ping' }, '10000000-0000-4000-8000-000000000003');
            },
            /matches this Account/
        );
    } finally {
        (global as any).chrome = origChrome;
    }
});

// 4. Conversations Store Empty Slot Isolation Tests
test('conversationsStore - refresh does not hijack a selected empty account', async () => {
    const accounts = [{ id: A, providerId: 'gemini', providerAccountId: 'main' }, { id: B, providerId: 'gemini', providerAccountId: 'empty' }];
    const state = new ConversationViewState({ listAccounts: async () => accounts,
        listIndexes: async id => id === A ? [{ key: { accountId: A, conversationId: 'c1' }, title: 'Chat 1' }] : [],
        listExportRecords: async () => ({}) });
    state.selectAccount(B); await state.refresh();
    assert.equal(state.accountId, B); assert.deepEqual(state.indexes, []);
});

test('Options renders account display names or email fallbacks and preserves the selected UUID', async () => {
    const browser = await chromium.launch({ chromiumSandbox: true, headless: true });
    try {
        const page = await browser.newPage();
        await mount(page, 'options', { accounts: [
            { id: A, providerId: 'gemini', providerAccountId: 'one', displayName: '张三', email: 'zhangsan@gmail.com' },
            { id: B, providerId: 'gemini', providerAccountId: 'two', email: 'lisi@gmail.com' },
        ] });
        await page.locator('#list .item').waitFor();
        assert.deepEqual(await page.locator('#accountIdSelect option').allTextContents(), ['Gemini · 张三', 'Gemini · lisi@gmail.com']);
        assert.deepEqual(await page.locator('#accountIdSelect option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)), [A, B]);
        assert.equal(await page.locator('#accountIdSelect').isVisible(), true);
        await page.locator('#accountIdSelect').selectOption(B);
        // The source selector labels every option with its provider.
        await page.waitForFunction(() => document.querySelector('#list .item')?.textContent?.includes('B chat'));
        assert.equal(await page.locator('#accountIdSelect option:checked').textContent(), 'Gemini · lisi@gmail.com');
        assert.equal(await page.locator('#accountIdSelect').getAttribute('title'), 'lisi@gmail.com');
        assert.equal(await page.locator('#accountName').textContent(), '');
        assert.equal(await page.locator('#accountIdSelect').inputValue(), B);
    } finally { await browser.close(); }
});

test('credentialManager - concurrent resolveCred calls serialize safely without race condition', async () => {
    const origChrome = (global as any).chrome;
    try {
        let activeOps = 0;
        let maxActiveOps = 0;
        const credStore: any = {
            gemini_credentials_map: {
                sid_u0: {
                    sid: 'sid_u0',
                    at: 'TOKEN_U0',
                    accountSlot: 'u0',
                    lastUsed: 1000
                }
            }
        };

        (global as any).chrome = {
            storage: {
                session: {
                    get: async () => {
                        activeOps++;
                        if (activeOps > maxActiveOps) maxActiveOps = activeOps;
                        await new Promise(r => setTimeout(r, 10));
                        activeOps--;
                        return JSON.parse(JSON.stringify(credStore));
                    },
                    set: async (obj: any) => {
                        activeOps++;
                        if (activeOps > maxActiveOps) maxActiveOps = activeOps;
                        await new Promise(r => setTimeout(r, 10));
                        Object.assign(credStore, JSON.parse(JSON.stringify(obj)));
                        activeOps--;
                    }
                },
                local: {
                    get: async () => ({}),
                    set: async () => {},
                    remove: async () => {}
                }
            }
        };

        const results = await Promise.all([
            resolveCred('sid_u0'),
            resolveCred('sid_u0'),
            resolveCred('sid_u0'),
            resolveCred('sid_u0'),
            resolveCred('sid_u0'),
        ]);

        for (const res of results) {
            assert.strictEqual(res.sid, 'sid_u0');
            assert.strictEqual(res.at, 'TOKEN_U0');
        }
        assert.strictEqual(maxActiveOps, 1, 'Concurrent resolveCred calls must be serialized (maxActiveOps === 1)');
    } finally {
        (global as any).chrome = origChrome;
    }
});

test('accountSniffer - current Gemini Wiz tuple wins over another account DOM label', () => {
    const doc = {
        querySelectorAll: () => [{ getAttribute: (key: string) => key === 'aria-label' ? 'Google Account: Other (other@example.com)' : null }],
        defaultView: { WIZ_global_data: { qDCSke: '109876543210987654321', oPEP7c: 'ACTIVE@EXAMPLE.COM' } }
    } as unknown as Document;
    const profile = sniffUserProfileFromDom(doc);
    assert.equal(profile?.gaiaId, '109876543210987654321');
    assert.equal(profile?.email, 'active@example.com');
    assert.equal(profile?.name, undefined);
    assert.equal(profile?.email, 'active@example.com');
    assert.equal('accountId' in (profile || {}), false);
});

test('accountSniffer - obsolete or malformed Wiz fields do not become provider account IDs', () => {
    for (const wiz of [{ oTI7oc: '10987654321' }, { qDCSke: 'not-a-gaia-id' }, { qDCSke: 10987654321 }]) {
        const doc = { querySelectorAll: () => [], defaultView: { WIZ_global_data: wiz } } as unknown as Document;
        assert.equal(sniffUserProfileFromDom(doc), null);
    }
});
