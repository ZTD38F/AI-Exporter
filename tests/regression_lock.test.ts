export {};

/**
 * tests/regression_lock.test.ts
 * Consolidated regression locks for P0/P1/P2 issues and bug repros.
 * Merged from:
 *   - audit_p0_p2_fixes.test.ts
 *   - audit_p0_v143_regression.test.ts
 *   - bug_repro_critical.test.ts
 *   - perf_p1_p2_regression.test.ts
 *   - regression_p0.test.ts
 *   - p0_regression_lock.test.ts
 *
 * @retire-when: unknown — needs owner
 *   (per-test locks retire when the guarded behavior is covered by a permanent
 *   contract test; see tests/README.md §五)
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { __setModuleOverride, __getModuleOverride } = require('../src/core/utils/moduleOverrides.js');

const SRC = path.join(__dirname, '..', 'src');
const Proto = require('../src/core/protocol/protocol.js');
const { GeminiResponseParserClass, isRealTitle } = require('../src/core/api/geminiParser.js');
const Extractors = require('../src/core/api/parser/extractors.js');
const StorageService = require('../src/core/storage/storageService.js');
const TabService = require('../src/core/utils/tabService.js');
const GeminiUtils = require('../src/core/utils/utils.js');
const ListView = require('../src/ui/views/listView.js');
const ExportEngineMod = require('../src/core/engine/exportEngine.js');
const { ExportEngine } = ExportEngineMod;
const AssetPipeline = require('../src/core/engine/assetPipeline.js');
const AssetFetcherModule = require('../src/content/assetFetcher.js');
const TakeoutEngine = require('../src/core/engine/takeoutEngine.js');

// ---------------------------------------------------------------- helpers & mocks

function readSrc(relPath: string) {
    const fullJs = path.join(__dirname, relPath);
    if (fs.existsSync(fullJs)) return fs.readFileSync(fullJs, 'utf8');
    const fullTs = fullJs.replace(/\.js$/, '.ts');
    if (fs.existsSync(fullTs)) return fs.readFileSync(fullTs, 'utf8');
    return fs.readFileSync(fullJs, 'utf8');
}

function makeChromeStorage() {
    const data: Record<string, any> = {};
    return {
        data,
        storage: {
            local: {
                get: async (keys: any) => {
                    await Promise.resolve();
                    const keyList = Array.isArray(keys) ? keys : [keys];
                    const out: Record<string, any> = {};
                    for (const k of keyList) {
                        if (Object.prototype.hasOwnProperty.call(data, k)) {
                            out[k] = JSON.parse(JSON.stringify(data[k]));
                        }
                    }
                    return out;
                },
                set: async (items: any) => {
                    await Promise.resolve();
                    for (const [k, v] of Object.entries(items)) {
                        data[k] = JSON.parse(JSON.stringify(v));
                    }
                },
                remove: async (keys: any) => {
                    const keyList = Array.isArray(keys) ? keys : [keys];
                    for (const k of keyList) delete data[k];
                }
            },
            session: {
                get: async () => ({}),
                set: async () => {},
                remove: async () => {}
            }
        }
    };
}

const zipCaptures: [any, any][] = [];

class FakeJSZip {
    folder() {
        return {
            file: (name: any, content: any) => zipCaptures.push([name, content])
        };
    }
    async generateAsync(_opts?: any, onMeta?: any) {
        if (onMeta) onMeta({ percent: 100 });
        return { type: 'blob', size: 1 };
    }
}

class FakeAssetPipeline {
    constructor(_opts?: any) {}
    async processAsset(item: any, _chat?: any, _meta?: any) {
        return { saved: true, localName: item.localName || item.fileName || 'asset.bin' };
    }
}

async function runExport(chatDetail: any, { useFakePipeline = false }: { useFakePipeline?: boolean } = {}) {
    zipCaptures.length = 0;
    const origChrome = (global as any).chrome;
    const origJSZip = __getModuleOverride('JSZip');
    const origPipeline = __getModuleOverride('AssetPipeline');
    const origTab = __getModuleOverride('TabService');

    const chromeMock = makeChromeStorage();
    (global as any).chrome = chromeMock;
    __setModuleOverride('JSZip', FakeJSZip);
    if (useFakePipeline) __setModuleOverride('AssetPipeline', FakeAssetPipeline);
    else __setModuleOverride('AssetPipeline', undefined);

    __setModuleOverride('TabService', {
        sendToGeminiTab: async (msg: any) => {
            assert.strictEqual(msg.action, 'getConversationDetail');
            return { success: true, data: chatDetail };
        }
    });

    try {
        const onItemExportedCalls: any[] = [];
        const engine = new ExportEngine();
        const result = await engine.run(
            {
                selected: [{ id: chatDetail.id, title: chatDetail.title }],
                useZip: true,
                includeAssets: true,
                includeIndex: false,
                currentSlot: 'u0',
                conversations: [],
                downloadHandler: async () => {}
            },
            {
                onItemExported: (id: any, rec: any) => onItemExportedCalls.push({ id, rec }),
                onLog: () => {},
                onProgress: () => {},
                onTitleUpdated: () => {}
            }
        );
        // finalizeChatExport is fire-and-forget; poll until its storage chain
        // lands instead of a fixed sleep (flaky on slow machines).
        const deadline = Date.now() + 2000;
        for (;;) {
            const ids = await StorageService.getExportedIds('u0');
            if (ids[chatDetail.id] || ids['c_' + chatDetail.id]) break;
            if (Date.now() > deadline) break;
            await new Promise(r => setTimeout(r, 10));
        }
        const exportedIds = await StorageService.getExportedIds('u0');
        return { result, onItemExportedCalls, exportedIds, chromeData: chromeMock.data };
    } finally {
        (global as any).chrome = origChrome;
        __setModuleOverride('JSZip', origJSZip);
        __setModuleOverride('AssetPipeline', origPipeline);
        __setModuleOverride('TabService', origTab);
    }
}

function createHookSandbox() {
    const hookCode = fs.readFileSync(path.join(SRC, 'content', 'hookCredentials.js'), 'utf8');
    const protocolCode = fs.readFileSync(path.join(SRC, 'core', 'protocol', 'protocol.js'), 'utf8');

    const posted: any[] = [];
    const win: any = {};
    win.postMessage = (msg: any, origin: any) => posted.push({ msg, origin });
    win.addEventListener = () => {};
    win.__nextResponseText = '';
    win.fetch = async () => ({
        ok: true,
        clone() {
            return { text: async () => win.__nextResponseText };
        }
    });
    const sandbox: any = {
        window: win,
        location: { origin: 'https://gemini.google.com', href: 'https://gemini.google.com/app', pathname: '/app' },
        document: { querySelectorAll: () => [] },
        console: { log: () => {}, warn: () => {}, debug: () => {} },
        setTimeout: () => 0,
        URLSearchParams
    };
    vm.createContext(sandbox);
    vm.runInContext(protocolCode, sandbox, { filename: 'protocol.js' });
    win.GeminiProtocol = sandbox.GeminiProtocol;
    vm.runInContext(hookCode, sandbox, { filename: 'hookCredentials.js' });
    return { posted, win };
}

// ============================================================================
// Section 1: Behavioral Locks & End-to-End Export Finalize
// ============================================================================

test('p0-lock: conversation without assets is finalized exactly once and its record persisted', async () => {
    const chat = {
        id: 'aaaa1111bbbb2222',
        title: 'Plain Chat',
        timestamp: 1700000000000,
        messages: [
            { role: 'user', content: 'hi', timestamp: 1700000000000 },
            { role: 'model', content: 'hello', timestamp: 1700000000001 }
        ]
    };
    const { result, onItemExportedCalls, exportedIds } = await runExport(chat);
    assert.strictEqual(result.landedChats, 1, 'chat text must be exported');
    assert.strictEqual(onItemExportedCalls.length, 1, 'finalizeChatExport must fire exactly once');
    assert.ok(
        exportedIds['aaaa1111bbbb2222'] || exportedIds['c_aaaa1111bbbb2222'],
        'export record must be persisted to exportedIds'
    );
});

test('p0-lock: ZIP-mode contentMarkdown attachment no longer swallows the export record', async () => {
    const chat = {
        id: 'cccc3333dddd4444',
        title: 'Doc Chat',
        timestamp: 1700000000000,
        messages: [
            {
                role: 'model',
                content: 'doc answer',
                timestamp: 1700000000001,
                attachments: [{
                    type: 'file',
                    url: 'https://example.file/download',
                    contentMarkdown: 'embedded doc body',
                    localName: 'assets/doc.md',
                    fileName: 'doc.md'
                }]
            }
        ]
    };
    const { result, onItemExportedCalls, exportedIds } = await runExport(chat);
    assert.strictEqual(result.landedChats, 1, 'chat text must be exported');
    assert.ok(
        zipCaptures.some(([name]) => String(name).includes('doc.md')),
        'contentMarkdown attachment must be written into the ZIP'
    );
    assert.strictEqual(onItemExportedCalls.length, 1, 'finalizeChatExport must fire exactly once');
    assert.ok(
        exportedIds['cccc3333dddd4444'] || exportedIds['c_cccc3333dddd4444'],
        'export record must be persisted even when the only asset is a ZIP-inline contentMarkdown'
    );
});

test('p0-lock: staged image asset finalizes exactly once via the queue (no duplicate finalize)', async () => {
    const chat = {
        id: 'eeee5555ffff6666',
        title: 'Image Chat',
        timestamp: 1700000000000,
        messages: [
            {
                role: 'model',
                content: 'generated image',
                timestamp: 1700000000001,
                images: [{ url: 'https://lh3.example/img', fileName: 'img1.jpg', localName: 'assets/img1.jpg' }]
            }
        ]
    };
    const { result, onItemExportedCalls, exportedIds } = await runExport(chat, { useFakePipeline: true });
    assert.strictEqual(result.downloadedAssets, 1, 'image asset must be downloaded');
    assert.strictEqual(onItemExportedCalls.length, 1, 'finalizedChatsSet must prevent duplicate finalize');
    assert.ok(
        exportedIds['eeee5555ffff6666'] || exportedIds['c_eeee5555ffff6666'],
        'export record must be persisted after the asset completes'
    );
});

test('regression lock: asset-failure branch must decrement pendingAssetsPerChat (pendingAssets leak fix)', () => {
    const code = readSrc('../src/core/engine/export/exportOrchestrator.js');
    // 锁的本意不变：add(nid) 之后必须有 decrement，删掉即泄漏。
    // assetTask 失败分支里 decrement 紧跟 add(nid)（failedAttachments.push 在后），
    // 300 窗口足够；不要放宽窗口去迁就代码重排。
    const failureBlocks = [...code.matchAll(/chatFailedAssetsSet\.add\(nid\)[\s\S]{0,300}pendingAssetsPerChat/g)];
    assert.ok(failureBlocks.length >= 1, 'failure branch must decrement pendingAssetsPerChat after chatFailedAssetsSet.add(nid); a regression would reintroduce the pendingAssets leak that blocks finalize');
});

test('regression: export_engine sanitizeZipPath must sanitize .. and preserve segments', () => {
    assert.strictEqual(typeof ExportEngineMod.sanitizeZipPath, 'function', 'sanitizeZipPath should be exported');
    assert.strictEqual(ExportEngineMod.sanitizeZipPath('a/../b'), 'a/_/b');
    const san1 = ExportEngineMod.sanitizeZipPath('files/abc_../a.md');
    assert.ok(!san1.includes('..'), `san1 should not contain .., got ${san1}`);
    assert.ok(san1.startsWith('files/'), 'should preserve prefix');
    const sanitized = ExportEngineMod.sanitizeZipPath('files/../../etc/passwd');
    assert.ok(!sanitized.includes('..'), `sanitized should not contain .., got ${sanitized}`);
    assert.ok(sanitized.split('/').every((seg: string) => seg !== '..' && seg !== '.'), 'no dot segments');
    assert.strictEqual(ExportEngineMod.sanitizeZipPath('assets/ab1234_image-1.jpg'), 'assets/ab1234_image-1.jpg');
});

test('regression: export_engine must throw on batchDirHandle creation failure instead of fallback', () => {
    const content = readSrc('../src/core/engine/export/exportOrchestrator.js');
    assert.ok(content.includes('throw new Error(`无法创建导出子目录') || content.includes('throw new ExportPipelineError(`无法创建导出子目录'), 'should throw on directory creation failure');
    assert.ok(!content.includes('batchDirHandle = dirHandle;') || content.includes('throw new Error') || content.includes('throw new ExportPipelineError'), 'should not silently fallback to root dirHandle');
});

test('regression: export_engine failedChats must store detailed objects with error', () => {
    const orchContent = readSrc('../src/core/engine/export/exportOrchestrator.js');
    const recContent = readSrc('../src/core/engine/export/sessionRecovery.js');
    assert.ok(orchContent.includes('failedChats.push({ id:'), 'failedChats should push detailed objects');
    assert.ok(orchContent.includes("failedChats.push({ id: c.id, title:") || orchContent.includes("failedChats.push({ id: chat.id"), 'failedChats push should include title and error');
    assert.ok(recContent.includes('typeof fc === \'string\''), 'dev log should handle both string and object failedChats');
});

test('regression: export_engine getExtensionVersion should be exported and read manifest', () => {
    assert.strictEqual(typeof ExportEngineMod.getExtensionVersion, 'function');
    const v = ExportEngineMod.getExtensionVersion();
    assert.ok(typeof v === 'string' && v.length >= 5, `version should be string, got ${v}`);
});

test('regression: export abort must broadcast cancelExport and listen to abortSignal', () => {
    const expContent = readSrc('../src/core/engine/export/exportOrchestrator.js');
    assert.ok(expContent.includes("action: 'cancelExport'"), 'export_engine abort must broadcast cancelExport');
    assert.ok(expContent.includes('abortSignal.addEventListener'), 'export_engine fetchBatch must listen to abortSignal');
    const ctrlContent = readSrc('../src/ui/controllers/exportController.js');
    assert.ok(ctrlContent.includes("action: 'cancelExport'"), 'exportController abort must broadcast cancelExport');
});

test('regression: stop sync must sync window flag and active client', () => {
    const clientContent = readSrc('../src/core/api/geminiClient.js');
    const contentContent = readSrc('../src/content/content.js') + readSrc('../src/content/messageRouter.js') + readSrc('../src/content/contentContext.js');
    assert.ok(clientContent.includes('window.__gemExporterAborted') && clientContent.includes('isAborted'), 'gemini_client should check window abort flag');
    assert.ok(contentContent.includes('__gemExporterActiveClient'), 'content should store active client');
    assert.ok(contentContent.includes('__gemExporterActiveClient && window.__gemExporterActiveClient.abort()') || contentContent.includes('w.__gemExporterActiveClient && w.__gemExporterActiveClient.abort()'), 'stopDeepScan should abort active client');
});

test('regression: empty cloud response must be logged as error with debug', () => {
    const expContent = readSrc('../src/core/engine/export/exportOrchestrator.js');
    assert.ok(expContent.includes("'error'") && expContent.includes('logExportSkipped'), 'empty should be error level');
    assert.ok(expContent.includes('_debug') && expContent.includes('_raw'), 'failedChats should carry debug/raw');
    const bgContent = readSrc('../src/background/background.js') + readSrc('../src/background/batchFetcher.js');
    assert.ok(bgContent.includes('_debug'), 'background should preserve _raw debug');
});

// ============================================================================
// Section 2: Protocol, Sniffing & Hook Credentials
// ============================================================================

test('p0-lock: deletion sniffing ignores hex decoys outside the GzXR5e payload context', async () => {
    const { posted, win } = createHookSandbox();
    const DECOY = 'aabbccdd11223344';
    const REAL = 'deadbeef00112233';
    const body = `f.req=[["${DECOY}"],["GzXR5e","c_${REAL}"]]`;

    await win.fetch('https://gemini.google.com/u/0/batchexecute', { method: 'POST', body });
    await new Promise(r => setTimeout(r, 5));

    const deletions = posted.filter(p => p.msg.type === 'GEMINI_CONVERSATION_DELETED');
    assert.strictEqual(deletions.length, 1, 'exactly one deletion event expected');
    assert.strictEqual(
        deletions[0].msg.payload.id,
        REAL,
        'deleted id must be the one anchored to the GzXR5e context, not the first hex token in the text'
    );
});

test('p0-lock: deletion sniffing also anchors ids arriving in the response body', async () => {
    const { posted, win } = createHookSandbox();
    win.__nextResponseText = ')]}\'\n\n[["wrb.fr","GzXR5e","c_feedface12345678",null]]';

    await win.fetch('https://gemini.google.com/u/0/batchexecute', {
        method: 'POST',
        body: 'f.req=[[["GzXR5e",null]]]'
    });
    await new Promise(r => setTimeout(r, 10));

    const deletions = posted.filter(p => p.msg.type === 'GEMINI_CONVERSATION_DELETED');
    assert.strictEqual(deletions.length, 1, 'exactly one deletion event expected');
    assert.strictEqual(deletions[0].msg.payload.id, 'feedface12345678');
});

test('p0-lock: hex ids without a GzXR5e anchor never trigger local conversation removal', async () => {
    const { posted, win } = createHookSandbox();
    win.__nextResponseText = ')]}\'\n\n[["wrb.fr","MaZiqc","[["aabbccdd11223344",null]]",null]]';

    await win.fetch('https://gemini.google.com/u/0/batchexecute', {
        method: 'POST',
        body: 'f.req=[["MaZiqc",null]]'
    });
    await new Promise(r => setTimeout(r, 10));

    const deletions = posted.filter(p => p.msg.type === 'GEMINI_CONVERSATION_DELETED');
    assert.strictEqual(deletions.length, 0, 'list-RPC responses containing bare hex must not fire deletion events');
});

test('hookCredentials - broadcastBatchexecute filter only relays LIST and DETAIL payloads', async () => {
    // Drives the REAL filter inside hookCredentials (via the fetch-interception
    // sandbox), not a hand copy: batchexecute response text flows through the
    // actual broadcastBatchexecute, which only relays when the text mentions
    // the LIST or DETAIL RPC ids.
    const prefix = String.fromCharCode(41, 93, 125, 39) + '\n';
    const batchexecuteUrl = 'https://gemini.google.com/u/0/batchexecute';

    async function relayedTypesFor(responseText: string): Promise<string[]> {
        const { posted, win } = createHookSandbox();
        win.__nextResponseText = responseText;
        await win.fetch(batchexecuteUrl, { method: 'POST', body: 'f.req=[[["wrb.fr",null]]]' });
        // The relay resolves in a few ms via the promise chain; 500ms is ample
        // margin without making negative cases (filtered out) slow.
        const deadline = Date.now() + 500;
        for (;;) {
            const types = posted.map((p: any) => p.msg.type);
            if (types.includes('GEMINI_NETWORK_BATCHEXECUTE') || Date.now() > deadline) return types;
            await new Promise(r => setTimeout(r, 10));
        }
    }
    async function wasRelayed(responseText: string): Promise<boolean> {
        return (await relayedTypesFor(responseText)).includes('GEMINI_NETWORK_BATCHEXECUTE');
    }

    const genericBatchexecute = prefix + JSON.stringify([['wrb.fr', 'generic_rpc', '[]', null]]);
    assert.strictEqual(await wasRelayed(genericBatchexecute), false, 'Generic wrb.fr response must be filtered out');

    const deleteBatchexecute = prefix + JSON.stringify([['wrb.fr', 'GzXR5e', ['deleted'], null]]);
    assert.strictEqual(await wasRelayed(deleteBatchexecute), false, 'Delete RPC response must not pass batchexecute broadcast');

    const listBatchexecute = prefix + JSON.stringify([['wrb.fr', Proto.RPCS.LIST, ['c_123'], null]]);
    assert.strictEqual(await wasRelayed(listBatchexecute), true, 'List RPC must pass filter');

    const detailBatchexecute = prefix + JSON.stringify([['wrb.fr', Proto.RPCS.DETAIL, ['c_123'], null]]);
    assert.strictEqual(await wasRelayed(detailBatchexecute), true, 'Detail RPC must pass filter');
});

test('bootstrap - runSerializedCredOp serializes concurrent read-modify-write cycles', async () => {
    // runSerializedCredOp is module-private in bootstrap.ts, so this test
    // exercises the identical chain idiom below AND locks the source shape:
    // if the source stops chaining through _credOpChain and the shared map lock, this
    // fails instead of silently testing a diverged copy. (readSrc returns the
    // bundled output for bootstrap.js, hence (let|var).)
    const src = readSrc('../src/content/bootstrap.js');
    assert.ok(
        /(?:let|var) _credOpChain[\s\S]*_credOpChain\.then\([\s\S]{0,160}withCredMapLock/.test(src),
        'bootstrap.ts must serialize credential operations under the shared map lock'
    );

    let credOpChain: Promise<any> = Promise.resolve();
    function runSerializedCredOp(op: any) {
        const run = credOpChain.then(op, op);
        credOpChain = run.then(() => undefined, () => undefined);
        return run;
    }

    let storageMap: Record<string, any> = {};
    const executionOrder: string[] = [];

    async function updateCred(sid: string, atValue: string, delayMs: number) {
        return runSerializedCredOp(async () => {
            executionOrder.push('start:' + sid);
            await new Promise(r => setTimeout(r, delayMs));
            const currentMap = { ...storageMap };
            currentMap[sid] = { sid, at: atValue, lastUsed: Date.now() };
            await new Promise(r => setTimeout(r, 10));
            storageMap = currentMap;
            executionOrder.push('end:' + sid);
            return storageMap;
        });
    }

    const p1 = updateCred('sid_1', 'at_token_1', 30);
    const p2 = updateCred('sid_2', 'at_token_2', 10);
    const p3 = updateCred('sid_3', 'at_token_3', 5);

    await Promise.all([p1, p2, p3]);

    assert.ok(storageMap.sid_1, 'sid_1 must be present');
    assert.ok(storageMap.sid_2, 'sid_2 must be present');
    assert.ok(storageMap.sid_3, 'sid_3 must be present');
    assert.strictEqual(storageMap.sid_1.at, 'at_token_1');
    assert.strictEqual(storageMap.sid_2.at, 'at_token_2');
    assert.strictEqual(storageMap.sid_3.at, 'at_token_3');

    assert.deepStrictEqual(executionOrder, [
        'start:sid_1', 'end:sid_1',
        'start:sid_2', 'end:sid_2',
        'start:sid_3', 'end:sid_3'
    ], 'Credential operations must execute strictly serialized');
});

// ============================================================================
// Section 3: API Parser, Title Extraction & Deduplication
// ============================================================================

test('audit fix: robustFirstPayload preserves , null , and control characters inside user content strings', () => {
    const testContent = 'Special test message with , null , in code and [brackets]';
    const turns = [
        [ ['c_testid1234567890ab', 'r1'], null, [[testContent]], [[['rc1', [['answer1']]]]] ]
    ];
    const inner = [turns, null, 'Test Title'];
    const top = [['wrb.fr', 'hNvQHb', JSON.stringify(inner)]];
    const text = `)]}'\n\n${JSON.stringify(top)}`;
    const parsed = GeminiResponseParserClass.parseDetail(text, 'testid1234567890ab');
    assert.ok(parsed, 'Detail should be parsed successfully');
    assert.ok(parsed.messages && parsed.messages.length > 0, 'Messages should be extracted');
    assert.strictEqual(parsed.messages[0].content, testContent, 'Message content should not be altered by regex replacements');
});

test('P2 regression: robustFirstPayload executes in sub-linear time on large multiline payloads', () => {
    const lines = [")]}'", '['];
    for (let i = 0; i < 600; i++) {
        lines.push(`  ["turn_${i}", "user query with [nested bracket] ${i}", "response_${i}"],`);
    }
    lines.push('  ["final_turn", "query", "answer"]');
    lines.push(']');
    const payload = lines.join('\n');

    const t0 = performance.now();
    const result = Extractors.robustFirstPayload(payload);
    const elapsed = performance.now() - t0;

    assert.ok(Array.isArray(result), 'Payload must parse to array');
    assert.strictEqual(result.length, 601, 'Must extract all 601 items');
    assert.ok(
        elapsed < 35,
        `robustFirstPayload must parse 600 lines in < 35ms, took ${elapsed.toFixed(1)}ms`
    );
});

test('P2 regression: robustFirstPayload handles strings containing brackets without corrupting structure', () => {
    const jsonStr = `)]}'\n\n[[ "wrb.fr", "MaZiqc", "[[\\"c_123\\", \\"Title [with bracket]\\", [1700000000, 0]]]" ]]`;
    const res = Extractors.robustFirstPayload(jsonStr);
    assert.ok(Array.isArray(res));
    assert.strictEqual(res.length, 1);
    assert.strictEqual(res[0][0], 'wrb.fr');
    assert.strictEqual(res[0][1], 'MaZiqc');
});

test('audit fix: isRealTitle fallback filters invalid titles properly', () => {
    assert.strictEqual(isRealTitle('Sign in with Google'), false, 'Sign in should be filtered');
    assert.strictEqual(isRealTitle('未命名对话(3)', 'c_123'), false, 'Numbered untitled should be filtered');
    assert.strictEqual(isRealTitle('搜索'), false, 'Search should be filtered');
    assert.strictEqual(isRealTitle('Valid Chat Title 2026', 'c_123'), true, 'Real title should be accepted');
});

test('regression: export_engine and options must scrub Google Gemini brand', () => {
    const expContent = readSrc('../src/core/engine/export/batchWorker.js');
    const titleUtilsContent = readSrc('../src/core/utils/titleUtils.js');
    const optContent = readSrc('../src/ui/options/options.js');
    assert.ok(expContent.includes('isBadBrand') || expContent.includes('isBrandPlaceholderTitle'), 'batchWorker should have isBadBrand scrub');
    assert.ok(expContent.includes('Google\\s+)?(Gemini|Bard') || titleUtilsContent.includes('Google\\s+)?(Gemini|Bard'), 'batchWorker/titleUtils should filter brand regex');
    assert.ok(optContent.includes('isBad'), 'options.js should scrub bad titles on load');
    assert.strictEqual(isRealTitle('Google Gemini', 'abc123'), false);
    assert.strictEqual(isRealTitle('Gemini', 'abc123'), false);
});

test('regression: gemini_parser image naming must be globally unique across turns', () => {
    const seq = { value: 1 };
    const imgObj1 = ['https://lh3.googleusercontent.com/a1b2c3d4', 100, 200];
    const imgObj2 = ['https://lh3.googleusercontent.com/e5f6g7h8', 300, 400];
    const res1 = GeminiResponseParserClass.extractImages([imgObj1], seq);
    const res2 = GeminiResponseParserClass.extractImages([imgObj2], seq);
    assert.strictEqual(res1.length, 1);
    assert.strictEqual(res2.length, 1);
    assert.notStrictEqual(res1[0].fileName, res2[0].fileName, `fileName should be unique, got both ${res1[0].fileName}`);
    assert.ok(res2[0].fileName.includes('image-2') || res2[0].fileName.includes('image-1') === false, 'second image should have incremented counter');
    const seq2 = { value: 1 };
    GeminiResponseParserClass.extractImages([imgObj1], seq2);
    const r2 = GeminiResponseParserClass.extractImages([imgObj1, imgObj2], seq2);
    assert.strictEqual(r2.length, 2);
});

test('regression: parseDetail across 2 turns with different images should have distinct localNames', () => {
    const turns = [
        [ ['c_testid1234567890ab', 'r1'], null, [['prompt1']], [[['rc1', [['answer1', null, null, null, null, [['https://lh3.googleusercontent.com/imgA', 100, 200, 'tokA']]]]]]] ],
        [ ['c_testid1234567890ab', 'r2'], null, [['prompt2']], [[['rc2', [['answer2', null, null, null, null, [['https://lh3.googleusercontent.com/imgB', 300, 400, 'tokB']]]]]]] ]
    ];
    const inner = [turns, null, 'Test Title'];
    const top = [['wrb.fr', 'hNvQHb', JSON.stringify(inner)]];
    const text = `)]}'\n\n${JSON.stringify(top)}`;
    const parsed = GeminiResponseParserClass.parseDetail(text, 'testid1234567890ab');
    const allImgs = parsed.messages.flatMap((m: any) => m.images || []);
    const localNames = allImgs.map((i: any) => i.localName);
    const uniq = new Set(localNames);
    assert.strictEqual(localNames.length, uniq.size, `localNames must be unique, got ${JSON.stringify(localNames)}`);
});

test('regression: parseDetail across 3 turns with single deep research doc should deduplicate to exactly 1 attachment', () => {
    const docChip = ['https://googleusercontent.com/immersive_entry_chip/123', 'doc_id_123', '12345678-1234-1234-1234-123456789abc', '深度研究方案', null, [1774139824]];
    const turns = [
        [ ['c_doc_test_123', 'r1'], null, [['prompt1']], [[['rc1', [['answer1']]]]] ],
        [ ['c_doc_test_123', 'r2'], null, [['prompt2']], [[['rc2', [['answer2']]]]] ],
        [ ['c_doc_test_123', 'r3'], null, [['prompt3']], [[['rc3', [['answer3']]]]] ]
    ];
    const longMarkdown = '# 深度研究方案报告内容\n\n' + '这是深度研究报告的正文详细内容，包含多个段落与分析。'.repeat(10);
    const inner = [turns, null, [docChip], [longMarkdown]];
    const top = [['wrb.fr', 'hNvQHb', JSON.stringify(inner)]];
    const text = `)]}'\n\n${JSON.stringify(top)}`;
    const parsed = GeminiResponseParserClass.parseDetail(text, 'doc_test_123');

    assert.strictEqual(parsed.attachmentCount, 1, `attachmentCount should be 1, got ${parsed.attachmentCount}`);
    const msgsWithDocs = parsed.messages.filter((m: any) => m.documents && m.documents.length);
    assert.strictEqual(msgsWithDocs.length, 1, `only 1 message should hold the document, got ${msgsWithDocs.length}`);
});

// ============================================================================
// Section 4: Storage, Tabs & Slot Isolation
// ============================================================================

test('audit fix: saveExportRecord serializes concurrent writes without losing records', async () => {
    const memoryStorage: Record<string, any> = {};
    const origChrome = (global as any).chrome;
    (global as any).chrome = {
        storage: {
            local: {
                get: async (keys: any) => {
                    const res: Record<string, any> = {};
                    const keyList = Array.isArray(keys) ? keys : [keys];
                    for (const k of keyList) {
                        if (memoryStorage[k]) res[k] = JSON.parse(JSON.stringify(memoryStorage[k]));
                    }
                    return res;
                },
                set: async (items: any) => {
                    await new Promise(r => setTimeout(r, Math.random() * 5));
                    for (const [k, v] of Object.entries(items)) {
                        memoryStorage[k] = JSON.parse(JSON.stringify(v));
                    }
                }
            }
        }
    };

    try {
        const promises: Promise<any>[] = [];
        for (let i = 1; i <= 10; i++) {
            promises.push(StorageService.saveExportRecord('u0', `chat_${i}`, { title: `Chat ${i}`, exportedAt: new Date().toISOString() }));
        }
        await Promise.all(promises);

        const saved = await StorageService.getExportedIds('u0');
        for (let i = 1; i <= 10; i++) {
            assert.ok(saved[`chat_${i}`], `Record chat_${i} must not be lost due to concurrent read-modify-write`);
        }
    } finally {
        (global as any).chrome = origChrome;
    }
});

test('audit fix: tabService strictly isolates non-u0 slots without silent cross-slot fallback', async () => {
    const origChrome = (global as any).chrome;
    (global as any).chrome = {
        tabs: {
            query: async () => [
                { id: 1, url: 'https://gemini.google.com/app/1', active: false },
                { id: 2, url: 'https://gemini.google.com/u/0/app/1', active: true }
            ]
        }
    };

    try {
        const tabU1 = await TabService.getGeminiTab('u1');
        assert.strictEqual(tabU1, null, 'getGeminiTab(u1) should return null when no u1 tab is open, avoiding u0 fallback');

        await assert.rejects(
            async () => {
                await TabService.sendToGeminiTab({ action: 'ping' }, 'u1');
            },
            /未找到多账号 slot u1 对应的 Gemini 标签页/,
            'sendToGeminiTab(u1) should reject when no u1 tab exists'
        );
    } finally {
        (global as any).chrome = origChrome;
    }
});

test('Bug repro - network batchexecute slot isolation dropped', async () => {
    const contentPath = path.resolve(__dirname, '../src/content/content.js');
    const bridgePath = path.resolve(__dirname, '../src/content/messageBridge.js');
    const code = (fs.existsSync(bridgePath) ? fs.readFileSync(bridgePath, 'utf8') : '') + '\n' + fs.readFileSync(contentPath, 'utf8');

    assert.ok(code.includes('const { text, slot }'), 'should destructure slot from payload');

    const networkListCalls = [...code.matchAll(/upsertConversations\s*\(\s*listRes\.conversations\s*,\s*['"]network-list['"]/g)];
    assert.ok(networkListCalls.length >= 1, 'should have upsertConversations for network-list');

    const lines = code.split('\n');
    let bugLine = null;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("upsertConversations(listRes.conversations, 'network-list')") ||
            lines[i].includes('upsertConversations(listRes.conversations, "network-list")')) {
            const ctx = lines.slice(Math.max(0, i - 5), i + 6).join('\n');
            if (!ctx.includes('slot')) {
                bugLine = lines[i].trim();
                break;
            }
        }
    }
    assert.strictEqual(bugLine, null, `Bug: network-list upsert ignores slot, found: "${bugLine}" (会导致u1数据写入u0)`);
});

// ============================================================================
// Section 5: Asset Pipeline & Takeout Merging
// ============================================================================

test('P1 regression: AssetPipeline requests native ArrayBuffer (preferBuffer: true) to prevent Base64 OOM', async () => {
    let capturedMessage: any = null;
    const origChrome = (global as any).chrome;
    (global as any).chrome = {
        tabs: {
            sendMessage: (_tabId: any, message: any, callback: any) => {
                capturedMessage = message;
                callback({ success: true, dataBuffer: new ArrayBuffer(16) });
            }
        },
        runtime: { lastError: null }
    };

    try {
        const pipeline = new AssetPipeline({
            currentSlot: 'u0',
            getGeminiTab: async () => ({ id: 12345 }),
            useZip: true,
            writer: { writeFile: async () => 'test.png' }
        });

        const item = { url: 'https://lh3.googleusercontent.com/test.png', fileName: 'test.png' };
        const chat = { id: 'c_test123' };

        await pipeline.processAsset(item, chat, { isImage: true });

        assert.ok(capturedMessage, 'chrome.tabs.sendMessage must be called');
        assert.strictEqual(capturedMessage.action, 'downloadAssetDirect');
        assert.strictEqual(
            capturedMessage.preferBuffer,
            true,
            'P1 fix: AssetPipeline must send preferBuffer: true so that assetFetcher transmits ArrayBuffer instead of Base64'
        );
    } finally {
        (global as any).chrome = origChrome;
    }
});

test('assetFetcher - downloadAssetDirect hard caps > 50MB blob and rejects immediately', async () => {
    const downloadAssetDirect = AssetFetcherModule.downloadAssetDirect ||
        (AssetFetcherModule.AssetFetcher && AssetFetcherModule.AssetFetcher.downloadAssetDirect);

    assert.ok(typeof downloadAssetDirect === 'function', 'downloadAssetDirect function must exist');

    const oldFetch = (global as any).fetch;
    let fallbackCalled = false;
    try {
        const oversizedBytes = 51 * 1024 * 1024;
        (global as any).fetch = async () => ({
            ok: true,
            status: 200,
            headers: new Map([['content-type', 'application/octet-stream']]),
            blob: async () => ({
                size: oversizedBytes,
                type: 'application/octet-stream',
                arrayBuffer: async () => { fallbackCalled = true; return new ArrayBuffer(0); }
            })
        });

        let response: any = null;
        await downloadAssetDirect({ url: 'https://example.com/oversized_file.bin' }, (resp: any) => {
            response = resp;
        });

        assert.ok(response, 'Response must be received');
        assert.strictEqual(response.success, false, 'Direct download of >50MB asset must return success: false');
        assert.ok(response.error && response.error.includes('asset too large'), 'Error message must specify asset too large');
        assert.ok(response.error.includes('Google Takeout'), 'Error message must guide user to Google Takeout');
        assert.strictEqual(fallbackCalled, false, 'Must not attempt to read arrayBuffer/toDataUrl on oversized blob');
    } finally {
        (global as any).fetch = oldFetch;
    }
});

test('Bug repro - takeout title stale when second block is non-explicit prompt', async () => {
    const origJSZip = (global as any).JSZip;
    (global as any).JSZip = require('../lib/jszip.min.js');
    const zip = new (global as any).JSZip();

    const html = `
    <html><body>
      <div class="outer-cell">
        <a href="https://gemini.google.com/app/BUG_REPRO_001">Link1</a>
        <div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Takeout conversation<br><p>model response 1</p></div>
      </div>
      <div class="outer-cell">
        <a href="https://gemini.google.com/app/BUG_REPRO_001">Link2</a>
        <div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Corrected Title<br><p>model response 2</p></div>
      </div>
    </body></html>
    `;
    zip.file('Takeout/Gemini/MyActivity.html', html);
    const buf = await zip.generateAsync({ type: 'nodebuffer' });

    try {
        TakeoutEngine.clearTakeoutData();
        const res = await TakeoutEngine.parseTakeoutZip(buf);
        assert.strictEqual(res.conversations.length, 1, 'should merge to 1 conversation');
        assert.strictEqual(res.conversations[0].title, 'Corrected Title', 'extractedMap title should be corrected');
        const offline = TakeoutEngine.getTakeoutOfflineChat('BUG_REPRO_001');
        assert.ok(offline, 'offline chat should exist');
        assert.strictEqual(offline.title, 'Corrected Title', 'offlineCache title should be sync to Corrected Title');
        assert.strictEqual(offline.titles.takeout, 'Corrected Title', 'offlineCache titles.takeout should be sync');
    } finally {
        (global as any).JSZip = origJSZip;
    }
});

// ============================================================================
// Section 6: UI, DOM Fallback Safety & Release Packaging
// ============================================================================

test('audit fix: listView escapes URL properly to prevent attribute injection', () => {
    const mockList = { innerHTML: '', addEventListener: () => {} };
    const origDoc = (global as any).document;
    (global as any).document = {
        getElementById: (id: string) => id === 'list' ? mockList : null
    };

    try {
        ListView.render([
            {
                id: 'test_xss',
                title: 'Test XSS Chat',
                url: 'https://gemini.google.com/app/test" onclick="alert(1)'
            }
        ] as any, {}, new Set());

        assert.ok(mockList.innerHTML.includes('&quot; onclick=&quot;alert(1)'), 'Double quotes in URL must be escaped');
        assert.ok(!mockList.innerHTML.includes('href="https://gemini.google.com/app/test" onclick="alert(1)"'), 'Raw double quote breakout must be prevented');
    } finally {
        (global as any).document = origDoc;
    }
});

test('regression: dom_scraper must try live document before fetch shell', () => {
    const domPath = fs.existsSync(path.join(__dirname, '../src/content/domScraper.js'))
        ? path.join(__dirname, '../src/content/domScraper.js')
        : path.join(__dirname, '../src/core/engine/domScraper.js');
    const domContent = fs.readFileSync(domPath, 'utf8');
    assert.ok(domContent.includes('location.pathname.includes(cleanId)'), 'should try live parseDoc when location matches');
    assert.ok(domContent.includes('debugCurrentPage'), 'should expose debugCurrentPage');
    assert.ok(domContent.includes('fallbackUsed'), 'parseDoc should log fallbackUsed');
});

test('regression: content.js must fallback to DOM when batchexecute returns empty', () => {
    const ctContent = readSrc('../src/content/content.js') + readSrc('../src/content/messageRouter.js');
    assert.ok(ctContent.includes('Array.isArray(detail.messages) && detail.messages.length > 0'), 'should check length>0 before success');
    assert.ok(ctContent.includes('batchexecute returned empty messages, fallback to DOM'), 'should warn and fallback');
});

test('regression: background Receiving end error must hint refresh', () => {
    const bfTsPath = path.join(__dirname, '../src/background/batchFetcher.ts');
    const bgPath = fs.existsSync(bfTsPath)
        ? bfTsPath
        : path.join(__dirname, '../src/background/background.js');
    const bgContent = fs.readFileSync(bgPath, 'utf8');
    assert.ok(bgContent.includes('Receiving end does not exist'), 'should handle Receiving end');
    assert.ok(bgContent.includes('刷新 gemini.google.com'), 'should hint refresh after reload');
});

test('release workflow - release package excludes TypeScript source and sourcemaps', () => {
    const buildPath = path.join(__dirname, '../build.js');
    const buildContent = fs.readFileSync(buildPath, 'utf8');
    const workflowPath = path.join(__dirname, '../.github/workflows/release.yml');
    const workflowContent = fs.readFileSync(workflowPath, 'utf8');

    // SSoT: build.js defines the exact packaging rules
    assert.ok(buildContent.includes("src -x 'src/*.ts'"), "build.js must exclude src/*.ts");
    assert.ok(buildContent.includes("'src/*/*/*/*.ts'"), "build.js must exclude nested .ts files");
    assert.ok(buildContent.includes("'dist/background/background.js'"), 'build.js must include background.js bundle');
    assert.ok(buildContent.includes("'dist/content/content.js'"), 'build.js must include content.js bundle');
    assert.ok(buildContent.includes("'dist/content/hook.js'"), 'build.js must include hook.js bundle');
    assert.ok(buildContent.includes("'dist/ui/options.js'"), 'build.js must include options.js bundle');
    assert.ok(buildContent.includes("'dist/ui/popup.js'"), 'build.js must include popup.js bundle');

    // release.yml delegates packaging to npm run package SSoT
    assert.ok(workflowContent.includes('npm run package'), 'release.yml must delegate packaging to npm run package');
});

test('architecture doc - all referenced src/ file paths must exist on disk', () => {
    const docPath = path.join(__dirname, '../docs/architecture.md');
    const docContent = fs.readFileSync(docPath, 'utf8');

    // Extract all `src/.../*.ts` file references from architecture.md
    const matches = docContent.matchAll(/`src\/([^`]+\.ts)`/g);
    const referencedFiles: string[] = [];
    for (const m of matches) {
        referencedFiles.push(m[1]);
    }

    assert.ok(referencedFiles.length >= 60, `architecture.md should reference at least 60 src files (found ${referencedFiles.length})`);

    const missingFiles: string[] = [];
    for (const relPath of referencedFiles) {
        const fullPath = path.join(__dirname, '../src', relPath);
        if (!fs.existsSync(fullPath)) {
            missingFiles.push(`src/${relPath}`);
        }
    }

    assert.deepStrictEqual(
        missingFiles,
        [],
        `The following files referenced in docs/architecture.md do not exist on disk:\n${missingFiles.join('\n')}`
    );
});

test('src/README.md - all referenced files in source tree must exist on disk', () => {
    const docPath = path.join(__dirname, '../src/README.md');
    const docContent = fs.readFileSync(docPath, 'utf8');

    // Extract all file names matching *.ts, *.d.ts, *.css, *.html
    const fileMatches = docContent.matchAll(/([a-zA-Z0-9_-]+(?:\.d)?\.(?:ts|css|html))/g);
    const referencedFiles = new Set<string>();
    for (const m of fileMatches) {
        referencedFiles.add(m[1]);
    }

    assert.ok(referencedFiles.size >= 50, `src/README.md should reference at least 50 src files (found ${referencedFiles.size})`);

    const missingFiles: string[] = [];
    for (const fileName of referencedFiles) {
        let found = false;
        const findRecursive = (dir: string) => {
            if (found) return;
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (found) return;
                if (entry.isDirectory()) {
                    findRecursive(path.join(dir, entry.name));
                } else if (entry.name === fileName) {
                    found = true;
                    return;
                }
            }
        };
        findRecursive(path.join(__dirname, '../src'));
        if (!found) {
            missingFiles.push(fileName);
        }
    }

    assert.deepStrictEqual(
        missingFiles,
        [],
        `The following files referenced in src/README.md do not exist on disk:\n${missingFiles.join('\n')}`
    );
});
