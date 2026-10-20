export {};
const test = require('node:test');
const assert = require('node:assert');

// Phase G (G4) P2 行为修复回归测试。

// ---------- P2-1: pagination 达 maxPages 必须标 stoppedEarly ----------
test('P2-1: getAllConversations 跑满 maxPages 时 stoppedEarly=true', async () => {
    const Pagination = require('../src/core/api/client/pagination.js');
    let callCount = 0;
    const mockClient = {
        getConversationList: async () => {
            callCount++;
            return {
                conversations: [{ id: `c_${callCount}`, title: `Chat ${callCount}` }],
                nextPageToken: `token_${callCount}` // 每次都给新游标，绝不自然到底
            };
        }
    };
    const result = await Pagination.getAllConversations(mockClient, 3);
    assert.strictEqual(callCount, 3, '应恰好拉取 3 页');
    assert.strictEqual(result.total, 3);
    assert.strictEqual(result.stoppedEarly, true, '跑满 maxPages 必须标 stoppedEarly（否则上层误判已穷尽）');
    assert.ok(result.diagnostics.stopReason.includes('最大页数'), 'stopReason 应说明页数上限');
});

test('P2-1 对照: 自然到底时 stoppedEarly 不为 true', async () => {
    const Pagination = require('../src/core/api/client/pagination.js');
    const mockClient = {
        getConversationList: async () => ({ conversations: [], nextPageToken: null })
    };
    const result = await Pagination.getAllConversations(mockClient, 2000);
    assert.ok(!result.stoppedEarly, '服务端自然到底不应标 stoppedEarly');
});

// ---------- P2-3: 401 先刷新 at，刷新失败才删凭证 ----------
function make401Deps(map: Record<string, any>) {
    const storage = {
        set: async (obj: Record<string, any>) => { Object.assign(map, JSON.parse(JSON.stringify(obj.gemini_credentials_map))); },
    };
    return {
        loadCredMap: async () => map,
        getCredStorage: () => storage,
    };
}

test('P2-3: 401 且页面有更新的 at → 刷新 at 并保留凭证', async () => {
    const RetryPolicy = require('../src/core/api/client/retryPolicy.js');
    const inner: Record<string, any> = { sid1: { at: 'stale-at', sid: 'sid1' } };
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: any[]) => { warns.push(a.join(' ')); };
    try {
        await RetryPolicy.handleHttp401({
            cred: { at: 'stale-at', sid: 'sid1' },
            ...make401Deps(inner),
            refreshAtFromPage: () => 'fresh-at-from-page'
        });
    } finally {
        console.warn = origWarn;
    }
    assert.ok(inner.sid1, '凭证不应被删除');
    assert.strictEqual(inner.sid1.at, 'fresh-at-from-page', 'at 应被刷新为页面最新值');
    assert.ok(warns.some(w => w.includes('刷新')), '应有 warn 说明走了刷新路径');
    assert.ok(warns.every(w => !w.includes('stale-at') && !w.includes('fresh-at-from-page')),
        'warn 必须脱敏：不得出现 token 明文');
});

test('P2-3: 401 且页面无更新的 at → 删除过期凭证', async () => {
    const RetryPolicy = require('../src/core/api/client/retryPolicy.js');
    const inner: Record<string, any> = { sid1: { at: 'stale-at', sid: 'sid1' } };
    const origWarn = console.warn;
    console.warn = () => {};
    try {
        await RetryPolicy.handleHttp401({
            cred: { at: 'stale-at', sid: 'sid1' },
            ...make401Deps(inner),
            refreshAtFromPage: () => 'stale-at' // 页面 at 与存储一致，无更新
        });
    } finally {
        console.warn = origWarn;
    }
    assert.ok(!inner.sid1, '刷新无果时才删除凭证');
});

test('P2-3: 401 且页面抓不到 at → 删除过期凭证（旧行为保留）', async () => {
    const RetryPolicy = require('../src/core/api/client/retryPolicy.js');
    const inner: Record<string, any> = { sid1: { at: 'stale-at', sid: 'sid1' } };
    const origWarn = console.warn;
    console.warn = () => {};
    try {
        await RetryPolicy.handleHttp401({
            cred: { at: 'stale-at', sid: 'sid1' },
            ...make401Deps(inner),
            refreshAtFromPage: () => null
        });
    } finally {
        console.warn = origWarn;
    }
    assert.ok(!inner.sid1, '抓不到 at 时沿用旧的删除逻辑');
});

test('P2-3: 401 但 map 中无此 sid → 两条路径都是 no-op（不写不抛）', async () => {
    const RetryPolicy = require('../src/core/api/client/retryPolicy.js');
    // map 里根本没有 sid9（可能已被其他 tab 删除）
    const inner: Record<string, any> = { sidOther: { at: 'x', sid: 'sidOther' } };
    let writes = 0;
    const storage = {
        set: async (obj: Record<string, any>) => {
            writes++;
            Object.assign(inner, JSON.parse(JSON.stringify(obj.gemini_credentials_map)));
        },
    };
    const origWarn = console.warn;
    console.warn = () => {};
    try {
        // fresh-at 路径：sid 不在 map 中，不应写入幻影条目
        await RetryPolicy.handleHttp401({
            cred: { at: 'stale-at', sid: 'sid9' },
            loadCredMap: async () => inner,
            getCredStorage: () => storage,
            refreshAtFromPage: () => 'fresh-at-from-page'
        });
        assert.strictEqual(writes, 0, 'fresh-at 路径：map 无此 sid 时不得写入');
        assert.ok(!inner.sid9, '不得创建幻影凭证条目');
        // delete 路径：sid 不在 map 中，同样 no-op
        await RetryPolicy.handleHttp401({
            cred: { at: 'stale-at', sid: 'sid9' },
            loadCredMap: async () => inner,
            getCredStorage: () => storage,
            refreshAtFromPage: () => null
        });
        assert.strictEqual(writes, 0, 'delete 路径：map 无此 sid 时不得写入');
        assert.deepStrictEqual(Object.keys(inner), ['sidOther'], '不得误删其他凭证');
    } finally {
        console.warn = origWarn;
    }
});

// ---------- P2-4: bootstrap hook payload 的 p.bl 优先 ----------
test('P2-4: GEMINI_CREDENTIALS 消息的 p.bl 优先于旧值与页面抓取值', async () => {
    const store: Record<string, any> = {};
    (globalThis as any).chrome = {
        runtime: { id: 'test-ext' },
        storage: {
            local: {
                get: async (keys: string[]) => {
                    const out: Record<string, any> = {};
                    for (const k of keys) if (k in store) out[k] = store[k];
                    return out;
                },
                set: async (obj: Record<string, any>) => { Object.assign(store, JSON.parse(JSON.stringify(obj))); },
                remove: async (keys: string[]) => { for (const k of keys) delete store[k]; }
            }
        }
    };
    const listeners: Record<string, Function[]> = {};
    const mockWindow: any = {
        addEventListener: (t: string, f: Function) => { (listeners[t] = listeners[t] || []).push(f); }
    };
    (globalThis as any).window = mockWindow;
    (globalThis as any).document = {
        querySelectorAll: () => [],
        documentElement: { innerHTML: '' },
        addEventListener: () => {}
    };
    (globalThis as any).location = { href: 'https://gemini.google.com/app', origin: 'https://gemini.google.com' };
    try {
        delete require.cache[require.resolve('../src/content/bootstrap.js')];
        require('../src/content/bootstrap.js');
        // 预置旧 bl
        store['gemini_credentials_map'] = {
            sid1: { at: 'old-at', sid: 'sid1', bl: 'old-bl', accountSlot: 'u0', lastUsed: 1 }
        };
        const handler = (listeners['message'] || [])[0];
        assert.ok(handler, 'bootstrap 应注册 message 监听器');
        await handler({
            source: mockWindow,
            origin: 'https://gemini.google.com',
            data: {
                type: 'GEMINI_CREDENTIALS',
                payload: { sid: 'sid1', at: 'hook-at', bl: 'hook-bl', url: 'https://gemini.google.com/app' }
            }
        });
        // runSerializedCredOp 是链式异步，等一拍
        for (let i = 0; i < 50 && store['gemini_credentials_map']?.sid1?.bl !== 'hook-bl'; i++) {
            await new Promise(r => setTimeout(r, 20));
        }
        assert.strictEqual(store['gemini_credentials_map'].sid1.bl, 'hook-bl',
            'hook payload 的 p.bl 必须优先（此前被丢弃，只用 old.bl/页面抓取）');
        assert.strictEqual(store['gemini_credentials_map'].sid1.at, 'hook-at');
    } finally {
        delete (globalThis as any).window;
        delete (globalThis as any).document;
        delete (globalThis as any).location;
        delete (globalThis as any).chrome;
        delete require.cache[require.resolve('../src/content/bootstrap.js')];
    }
});

// ---------- chatFormatter fail-closed ----------
test('P2: formatContent 未知格式显式抛错（不静默回落 markdown）', () => {
    const ChatFormatter = require('../src/core/engine/chatFormatter.js');
    const chat = { id: 'x', title: 't', messages: [] };
    assert.throws(() => ChatFormatter.formatContent(chat, 'pdf'), /unsupported format: pdf/);
    assert.throws(() => ChatFormatter.formatContent(chat, 'typo-format'), /unsupported format/);
    // 合法格式不受影响
    assert.throws(() => ChatFormatter.formatContent(chat, 'markdown'), /unsupported format: markdown/);
    assert.strictEqual(ChatFormatter.formatContent(chat, 'json').ext, 'json');
    assert.strictEqual(ChatFormatter.formatContent(chat, 'json_openai').ext, 'json');
    assert.strictEqual(ChatFormatter.formatContent(chat, 'json_raw').ext, 'json');
});

// ---------- P2-11: sessionStore 并发 updateSession 不丢更新 ----------
test('P2-11: 并发 updateSession 串行化，无 lost update', async () => {
    const memoryStorage: Record<string, any> = {};
    (globalThis as any).chrome = {
        storage: {
            local: {
                get: async (keys: string[]) => {
                    await new Promise(r => setTimeout(r, 5)); // 放大竞态窗口
                    const res: Record<string, any> = {};
                    for (const k of keys) if (k in memoryStorage) res[k] = memoryStorage[k];
                    return res;
                },
                set: async (obj: Record<string, any>) => {
                    await new Promise(r => setTimeout(r, 5));
                    Object.assign(memoryStorage, obj);
                },
                remove: async (keys: string[]) => { for (const k of keys) delete memoryStorage[k]; }
            }
        }
    };
    // navigator.locks 在 Node 24 原生存在；这里验证 fallback 链同样串行。
    // 为确定性，测试走"无 Web Locks → 内存链"路径与"有 Web Locks"路径两种情形。
    try {
        delete require.cache[require.resolve('../src/core/storage/sessionStore.js')];
        const { SessionStore, EXPORT_SESSION_KEY } = require('../src/core/storage/sessionStore.js');
        await SessionStore.setSession({ status: 'running' });
        const N = 10;
        await Promise.all(Array.from({ length: N }, (_, i) =>
            SessionStore.updateSession({ [`field_${i}`]: i })
        ));
        const final = memoryStorage[EXPORT_SESSION_KEY];
        for (let i = 0; i < N; i++) {
            assert.strictEqual(final[`field_${i}`], i, `field_${i} 丢失：并发写互相覆盖`);
        }
        assert.strictEqual(final.status, 'running', '原有字段应被 merge 保留');
    } finally {
        delete (globalThis as any).chrome;
        delete require.cache[require.resolve('../src/core/storage/sessionStore.js')];
    }
});

// ---------- P2-11: 无 Web Locks → 内存链 fallback 同样串行 ----------
test('P2-11: 无 Web Locks 时内存链 fallback 串行化', async () => {
    const memoryStorage: Record<string, any> = {};
    (globalThis as any).chrome = {
        storage: {
            local: {
                get: async (keys: string[]) => {
                    await new Promise(r => setTimeout(r, 5)); // 放大竞态窗口
                    const res: Record<string, any> = {};
                    for (const k of keys) if (k in memoryStorage) res[k] = memoryStorage[k];
                    return res;
                },
                set: async (obj: Record<string, any>) => {
                    await new Promise(r => setTimeout(r, 5));
                    Object.assign(memoryStorage, obj);
                },
                remove: async (keys: string[]) => { for (const k of keys) delete memoryStorage[k]; }
            }
        }
    };
    // Node 24 的 navigator 是 getter，直接赋值/删除无效，必须用 defineProperty 去掉 locks。
    const origDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    try {
        Object.defineProperty(globalThis, 'navigator', {
            value: {}, // 故意不带 locks，迫使 getWebLocks() 返回 null
            configurable: true,
            writable: true,
        });
        delete require.cache[require.resolve('../src/core/storage/sessionStore.js')];
        const { SessionStore, EXPORT_SESSION_KEY } = require('../src/core/storage/sessionStore.js');
        await SessionStore.setSession({ status: 'running' });
        const N = 10;
        await Promise.all(Array.from({ length: N }, (_, i) =>
            SessionStore.updateSession({ [`field_${i}`]: i })
        ));
        const final = memoryStorage[EXPORT_SESSION_KEY];
        for (let i = 0; i < N; i++) {
            assert.strictEqual(final[`field_${i}`], i, `field_${i} 丢失：内存链 fallback 未串行`);
        }
        assert.strictEqual(final.status, 'running', '原有字段应被 merge 保留');
    } finally {
        delete (globalThis as any).chrome;
        if (origDesc) Object.defineProperty(globalThis, 'navigator', origDesc);
        else delete (globalThis as any).navigator;
        delete require.cache[require.resolve('../src/core/storage/sessionStore.js')];
    }
});

// ---------- P2-11: 模拟 navigator.locks → 验证跨 tab 锁名 ----------
test('P2-11: 有 Web Locks 时使用锁名 gemini-exporter:write:session', async () => {
    const memoryStorage: Record<string, any> = {};
    (globalThis as any).chrome = {
        storage: {
            local: {
                get: async (keys: string[]) => {
                    const res: Record<string, any> = {};
                    for (const k of keys) if (k in memoryStorage) res[k] = memoryStorage[k];
                    return res;
                },
                set: async (obj: Record<string, any>) => { Object.assign(memoryStorage, obj); },
                remove: async (keys: string[]) => { for (const k of keys) delete memoryStorage[k]; }
            }
        }
    };
    const seenNames: string[] = [];
    const fakeLocks = {
        request: async (name: string, fn: () => Promise<any>) => {
            seenNames.push(name);
            return fn();
        }
    };
    const origDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    try {
        Object.defineProperty(globalThis, 'navigator', {
            value: { locks: fakeLocks },
            configurable: true,
            writable: true,
        });
        delete require.cache[require.resolve('../src/core/storage/sessionStore.js')];
        const { SessionStore, EXPORT_SESSION_KEY } = require('../src/core/storage/sessionStore.js');
        await SessionStore.setSession({ status: 'running' });
        await Promise.all([1, 2, 3].map(i => SessionStore.updateSession({ [`f${i}`]: i })));
        assert.ok(seenNames.length > 0, '有 Web Locks 时应走 locks.request');
        for (const n of seenNames) {
            assert.strictEqual(n, 'gemini-exporter:write:session', `跨 tab 锁名错误: ${n}`);
        }
        const final = memoryStorage[EXPORT_SESSION_KEY];
        assert.strictEqual(final.f1, 1);
        assert.strictEqual(final.f2, 2);
        assert.strictEqual(final.f3, 3);
    } finally {
        delete (globalThis as any).chrome;
        if (origDesc) Object.defineProperty(globalThis, 'navigator', origDesc);
        else delete (globalThis as any).navigator;
        delete require.cache[require.resolve('../src/core/storage/sessionStore.js')];
    }
});
