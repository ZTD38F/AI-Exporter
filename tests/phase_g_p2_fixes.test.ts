export {};
const test = require('node:test');
const assert = require('node:assert');

// Phase G (G4) P2 行为修复回归测试。

// List completion belongs to the provider; its safety budget is internal.
import { indexStorage } from './helpers/indexStorage.js';
import { ACCOUNT_UUID } from './helpers/accountRuntime.js';
import { GeminiProvider } from '../src/l1/client/gemini/geminiProvider.js';
import { sourceList, sourceDetail } from './helpers/l1SourceFixture.js';
import { getCoverage } from '../src/l2/coverageAdmission.js';
import { listIndexes } from '../src/l3a/storageService.js';
import { getStoredSettings, patchStoredSettings, SETTINGS_KEY } from '../src/l3a/settingsStore.js';
test('P2-1: safety-budget exhaustion remains distinct from a natural source end', async () => {
    const env = indexStorage(); let calls=0;
    try {
        const p = new GeminiProvider({getConversationList:async()=>sourceList(`G_SOURCE_PHASE_BUDGET_PAGE_${++calls}`),getConversationDetail:async()=>sourceDetail()},async()=> 'u0');
        assert.strictEqual(await p.listConversations({accountId:ACCOUNT_UUID,streamId:'recent'}), 'max_pages');
        assert.strictEqual(calls,2000); assert.strictEqual((await listIndexes(ACCOUNT_UUID)).length,2000);
        assert.strictEqual((await getCoverage(ACCOUNT_UUID,'recent'))?.range,null);
    } finally { env.restore(); }
});
test('P2-1: empty terminal page is a natural end', async () => {
    const env=indexStorage();try {
        const p=new GeminiProvider({getConversationList:async()=>sourceList('G_SOURCE_EMPTY_01'),getConversationDetail:async()=>sourceDetail()},async()=> 'u0');
        assert.strictEqual(await p.listConversations({accountId:ACCOUNT_UUID,streamId:'recent'}),'source_end');
    }finally{env.restore();}
});

// ---------- P2-3: 401 先刷新 at，刷新失败才删凭证 ----------
function make401Deps(map: Record<string, any>, onWrite = () => {}) {
    return {
        updateCredential: async (sid: string | number, decide: () => { patch: { at?: string; bl?: string } | null }) => {
            const { patch } = decide();
            if (!Object.hasOwn(map, sid)) return;
            if (patch === null) delete map[sid];
            else Object.assign(map[sid], patch);
            onWrite();
        },
    };
}

test('P2-3: 401 且页面有更新的 at → 刷新 at 并保留凭证', async () => {
    const RetryPolicy = require('../src/l1/client/gemini/api/retryPolicy.js');
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
    const RetryPolicy = require('../src/l1/client/gemini/api/retryPolicy.js');
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
    const RetryPolicy = require('../src/l1/client/gemini/api/retryPolicy.js');
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
    const RetryPolicy = require('../src/l1/client/gemini/api/retryPolicy.js');
    // map 里根本没有 sid9（可能已被其他 tab 删除）
    const inner: Record<string, any> = { sidOther: { at: 'x', sid: 'sidOther' } };
    let writes = 0;
    const origWarn = console.warn;
    console.warn = () => {};
    try {
        // fresh-at 路径：sid 不在 map 中，不应写入幻影条目
        await RetryPolicy.handleHttp401({
            cred: { at: 'stale-at', sid: 'sid9' },
            ...make401Deps(inner, () => { writes++; }),
            refreshAtFromPage: () => 'fresh-at-from-page'
        });
        assert.strictEqual(writes, 0, 'fresh-at 路径：map 无此 sid 时不得写入');
        assert.ok(!inner.sid9, '不得创建幻影凭证条目');
        // delete 路径：sid 不在 map 中，同样 no-op
        await RetryPolicy.handleHttp401({
            cred: { at: 'stale-at', sid: 'sid9' },
            ...make401Deps(inner, () => { writes++; }),
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
    const previous = new Map(['chrome', 'window', 'document', 'location'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const store: Record<string, any> = {};
    (globalThis as any).chrome = {
        runtime: { id: 'test-ext', sendMessage: async (message: any) => ({ok:true,value:{id:'10000000-0000-4000-8000-000000000003',providerId:message.providerId,providerAccountId:message.providerAccountId}}) },
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
        addEventListener: (t: string, f: Function) => { (listeners[t] = listeners[t] || []).push(f); },
        removeEventListener: (t: string, f: Function) => { listeners[t] = (listeners[t] || []).filter(listener => listener !== f); },
        // No Gaia in this fixture: answer the new MAIN-world query explicitly.
        postMessage: (message: any) => {
            if (message.type !== 'GEMINI_ACCOUNT_REQUESTED') return;
            queueMicrotask(() => {
                const event = { source: mockWindow, origin: 'https://gemini.google.com', data: {
                    type: 'GEMINI_ACCOUNT_OBSERVED', payload: { requestId: message.payload.requestId, slot: 'u0', observation: null }
                } };
                for (const listener of [...(listeners.message || [])]) listener(event);
            });
        }
    };
    (globalThis as any).window = mockWindow;
    (globalThis as any).document = {
        querySelectorAll: () => [],
        documentElement: { innerHTML: '' },
        addEventListener: () => {}, removeEventListener: () => {}
    };
    (globalThis as any).location = { href: 'https://gemini.google.com/app', origin: 'https://gemini.google.com' };
    try {
        delete require.cache[require.resolve('../src/l1/client/gemini/bootstrap.js')];
        require('../src/l1/client/gemini/bootstrap.js').initBootstrap();
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
        require('../src/runtime/content/cleanupRegistry.js').runCleanups();
        require('../src/runtime/content/accountContext.js').invalidateAccountContext();
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
        delete require.cache[require.resolve('../src/l1/client/gemini/bootstrap.js')];
    }
});

// PDF is now supported; formatting is owned by the unified export API.
import { runExport } from '../src/application/export/runExport.js';
import { v2ExportHost, seedExportConversation, exportRequest } from './helpers/v2ExportHost.js';
test('P2: current JSON export is delivered by the unified pipeline', async (t: import('node:test').TestContext) => {
    const h=v2ExportHost(t);await seedExportConversation('json');
    const result=await runExport(exportRequest(['json'],{format:'json'}));
    assert.strictEqual(result.exported,1);
    const body=JSON.parse(await h.blobs[0].text()); assert.ok(JSON.stringify(body).includes('Answer for json'));
});
test('P2-11: concurrent settings patches preserve all independent fields',async()=>{
    const env=indexStorage();try{
        await Promise.all([patchStoredSettings({language:'en'}),patchStoredSettings({includeAssets:false}),patchStoredSettings({enabledDisk:true}),patchStoredSettings({defaultFormat:'html'})]);
        const s=await getStoredSettings();assert.strictEqual(s.language,'en');assert.strictEqual(s.includeAssets,false);assert.strictEqual(s.enabledDisk,true);assert.strictEqual(s.defaultFormat,'html');
    }finally{env.restore();}
});
test('P2-11: unavailable Web Locks fails before writing settings',async()=>{
    const env=indexStorage(), previous=Object.getOwnPropertyDescriptor(globalThis,'navigator');
    try{Object.defineProperty(globalThis,'navigator',{configurable:true,value:{}});
        await assert.rejects(patchStoredSettings({language:'en'})); assert.deepStrictEqual(await getStoredSettings(),{});
    }finally{if(previous)Object.defineProperty(globalThis,'navigator',previous);else Reflect.deleteProperty(globalThis,'navigator');env.restore();}
});
test('P2-11: settings use one cross-tab Web Lock name',async()=>{
    const env=indexStorage(), previous=Object.getOwnPropertyDescriptor(globalThis,'navigator'), seen:string[]=[];
    try{Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(name:string,fn:()=>Promise<void>)=>{seen.push(name);return fn();}}}});
        await patchStoredSettings({language:'en'});assert.deepStrictEqual(seen,[SETTINGS_KEY]);
    }finally{if(previous)Object.defineProperty(globalThis,'navigator',previous);else Reflect.deleteProperty(globalThis,'navigator');env.restore();}
});
