import { decodeGeminiStructuredPayload } from '../src/l1/parsers/gemini/rpc/structuredContent.js';
import test from 'node:test';
import assert from 'node:assert/strict';
const fs = require('fs') as typeof import('node:fs');
import path from 'node:path';
import vm from 'node:vm';
import type { BlockNode } from '../src/l2/content/blocks.js';
import { parseMarkdownToBlocks } from '../src/l1/parsers/shared/markdown/index.js';
import { parseGeminiBody } from '../src/l1/parsers/gemini/shared/contentAdapter.js';
import { sourceConversation } from './helpers/l1SourceFixture.js';
import CredManager from '../src/l1/client/gemini/api/credentialManager.js';
import * as attachments from '../src/l1/parsers/gemini/rpc/sourceAttachments.js';
import * as Extractors from '../src/l1/parsers/gemini/rpc/extractors.js';
import { decodeGeminiDetail } from '../src/l1/parsers/gemini/rpc/detailDecoder.js';
import { listGen as geminiListGen } from './fixtures/providers/gemini.js';
import { requestGen as geminiListRequestGen } from './fixtures/providers/geminiListRequest.js';
import { detailGen as geminiDetailGen } from './fixtures/providers/geminiDetail.js';
import { deleteGen as geminiDeleteGen } from './fixtures/providers/geminiDelete.js';
import { isRealTitle } from '../src/l1/parsers/gemini/rpc/extractors.js';

const SRC = path.join(__dirname, '..', 'src');
const paragraph = (text: string): BlockNode[] => [{ type: 'paragraph', children: [{ type: 'text', text }] }];

// --- From content-input-boundary.test.ts (L1 source content adapter & markdown boundary) ---
test('Gemini chooses provider structure before Domain and does not reinterpret structured text as Markdown', () => {
    const { conversation: domain } = sourceConversation({ id: 'content-input', title: 'Content boundary', messages: [{
        id: 'm1', role: 'model', content: 'raw **fallback**',
        structuredContent: { children: [{ nodeType: 18, text: '**literal structure**' }] },
    }] });
    assert.deepEqual(domain.detail.messages[0].content, paragraph('**literal structure**'));
});

for (const structured of [
    { children: [{ nodeType: 99, text: 'unsupported' }] },
    { children: [{ nodeType: 20, items: [{ children: [{ nodeType: 99 }] }] }] },
    { children: [{ nodeType: 18, text: 'bad', annotations: [null] }] },
    { children: [{ nodeType: 18, text: 'bad', annotations: { length: 1 } }] },
    { children: [{ nodeType: 18, text: 'bad', annotations: [{ start: 0, end: 100, type: 0 }] }] },
    { children: [{ nodeType: 17, rows: [{ cells: null }] }] },
    { children: [] },
]) {
    test(`malformed or unsupported structured input preserves its full Markdown fallback: ${JSON.stringify(structured)}`, () => {
        assert.deepEqual(parseGeminiBody('# Visible\n\n**answer**', decodeGeminiStructuredPayload(structured) ?? undefined), [
            { type: 'heading', level: 1, children: [{ type: 'text', text: 'Visible' }] },
            { type: 'paragraph', children: [{ type: 'strong', children: [{ type: 'text', text: 'answer' }] }] },
        ]);
    });
}

test('generic Markdown parses images through the caller-provided asset resolver', () => {
    const ctx = { diagnostics: [], sourceRef: { providerId: 'other', locator: 'content' },
        resolveImage: (ref: string, alt: string) => ({ type: 'image' as const, assetId: `resolved:${ref}`, alt }),
    };
    assert.deepEqual(parseMarkdownToBlocks('![diagram](image.png)', '', ctx), [{
        type: 'paragraph', children: [{ type: 'image', assetId: 'resolved:image.png', alt: 'diagram' }],
    }]);
});

// --- From p0_regressions.test.ts (P0-2 credential backfill) ---
test('P0-2: resolveCred backfill must not drop other accounts from the credential map', async () => {
    const sessionStore: Record<string, any> = {};
    const prevChrome = (global as any).chrome;
    const prevDocument = (global as any).document;
    const prevLocation = (global as any).location;
    const prevHook = (globalThis as any).__gemExporterExtractAt;
    (global as any).chrome = {
        storage: {
            session: {
                get: async (keys: string[]) => {
                    const r: Record<string, any> = {};
                    for (const k of keys) if (k in sessionStore) r[k] = sessionStore[k];
                    return r;
                },
                set: async (obj: any) => { Object.assign(sessionStore, obj); },
                remove: async (keys: string[]) => { for (const k of keys) delete sessionStore[k]; },
            },
        },
    };
    (global as any).document = { documentElement: { innerHTML: '' }, querySelectorAll: () => [] };
    (global as any).location = { pathname: '/app' };
    (globalThis as any).__gemExporterExtractAt = () => 'PAGE_AT_FRESH';
    try {
        await (global as any).chrome.storage.session.set({
            gemini_credentials_map: {
                bad: { sid: 'bad', at: '', bl: 'BL_X', accountSlot: 'default', lastUsed: 1 },
                good: { sid: 'good', at: 'AT_GOOD', bl: 'BL_X', accountSlot: 'u1', lastUsed: 2 },
            },
        });
        const resolved = await CredManager.resolveCred();
        const after: Record<string, any> = sessionStore.gemini_credentials_map || {};
        assert.deepStrictEqual(
            Object.keys(after).sort(), ['bad', 'good'],
            `credential map was overwritten during backfill, keys now: ${JSON.stringify(Object.keys(after))}`
        );
        assert.strictEqual(after.good.at, 'AT_GOOD', 'the other account credential must be preserved');
        assert.strictEqual(after.bad.at, 'PAGE_AT_FRESH', 'this fixture must actually exercise AT backfill');
        assert.strictEqual(resolved.at, 'PAGE_AT_FRESH', 'resolved credentials should use the new page token');
    } finally {
        (global as any).chrome = prevChrome;
        if (prevDocument === undefined) delete (global as any).document;
        else (global as any).document = prevDocument;
        if (prevLocation === undefined) delete (global as any).location;
        else (global as any).location = prevLocation;
        if (prevHook === undefined) delete (globalThis as any).__gemExporterExtractAt;
        else (globalThis as any).__gemExporterExtractAt = prevHook;
    }
});

// --- From user_file_attachment.test.ts (L1 source attachment extraction) ---
test('user_file_attachment: itemMatchesFilename correctly identifies valid filenames and rejects URLs', () => {
    assert.strictEqual(attachments.itemMatchesFilename('architecture.md'), true);
    assert.strictEqual(attachments.itemMatchesFilename('payload.json'), true);
    assert.strictEqual(attachments.itemMatchesFilename('script.py'), true);
    assert.strictEqual(attachments.itemMatchesFilename('notes.txt'), true);
    assert.strictEqual(attachments.itemMatchesFilename('data.custom'), true);
    assert.strictEqual(attachments.itemMatchesFilename('random_token_123.dat'), true);
    assert.strictEqual(attachments.itemMatchesFilename('https://example.com/doc.pdf'), false);
    assert.strictEqual(attachments.itemMatchesFilename('https://contribution.usercontent.google.com/download?c=123&filename=architecture.md'), false);
    assert.strictEqual(attachments.itemMatchesFilename('http://lh3.googleusercontent.com/pic.png'), false);
    assert.strictEqual(attachments.itemMatchesFilename('//cdn.google.com/file.txt'), false);
    assert.strictEqual(attachments.itemMatchesFilename('architecture.md?download=1'), false);
    assert.strictEqual(attachments.itemMatchesFilename('foo/bar.md'), false);
    assert.strictEqual(attachments.itemMatchesFilename(''), false);
});

test('user_file_attachment: extractFileNameFromUrl extracts filenames from query params and paths', () => {
    const u1 = 'https://contribution.usercontent.google.com/download?c=CgxiYXJkX3N0b3JhZ2U&filename=architecture.md&opi=103135050';
    assert.strictEqual(attachments.extractFileNameFromUrl(u1), 'architecture.md');
    const u2 = 'https://contribution.usercontent.google.com/download?c=123&filename=%E6%9E%B6%E6%9E%84%E8%AE%BE%E8%AE%A1%E6%8A%A5%E5%91%8A.json&opi=456';
    assert.strictEqual(attachments.extractFileNameFromUrl(u2), '架构设计报告.json');
    const u3 = 'https://contribution.usercontent.google.com/download?c=456&filename=test_run.custom&foo=bar';
    assert.strictEqual(attachments.extractFileNameFromUrl(u3), 'test_run.custom');
    const u4 = 'https://drive.google.com/uc?export=download&id=123/sample_data.csv';
    assert.strictEqual(attachments.extractFileNameFromUrl(u4), 'sample_data.csv');
});

test('user_file_attachment: extractUserFiles handles real Gemini payload with Drive thumb and Contribution download URL', () => {
    const downloadUrl = 'https://contribution.usercontent.google.com/download?c=CgxiYXJkX3N0b3JhZ2USTxIMcmVxdWVzdF9kYXRhGj8KMDFhMzNjNWM1NjdkOWMwZDEwMDA2NWJkYWZiODRmMGYxMDI4YTFmZjJlZTNhNmFjYRILEgcQwLPF9o4VGAE&filename=architecture.md&opi=103135050';
    const realTurnUserPayload = [[
        "请评估附件中的架构设计报告", null, null,
        [["https://drive.google.com/viewer/thumb?ds=AAEAbe2jCEW-mock&ck=contribservice&dsmi=unknown&w=400&p=proj", downloadUrl, "file_token_273175"]]
    ]];
    const extracted = attachments.extractUserFiles(realTurnUserPayload);
    assert.strictEqual(extracted.length, 1);
    const f = extracted[0];
    assert.strictEqual(f.fileName, 'architecture.md');
    assert.strictEqual(f.sourceUrl, downloadUrl);
    assert.ok(f.thumbnailUrl && f.thumbnailUrl.includes('drive.google.com/viewer/thumb'));
});

test('user_file_attachment: extractUserFiles supports multiple diverse extensions (.json, .txt, .custom)', () => {
    const payload = [[
        "请分析这些配置和数据文件",
        [
            ["https://drive.google.com/viewer/thumb?ds=thumb1&w=400", "https://contribution.usercontent.google.com/download?c=1&filename=config.json&opi=1"],
            ["https://drive.google.com/viewer/thumb?ds=thumb2&w=400", "https://contribution.usercontent.google.com/download?c=2&filename=notes.txt&opi=2"],
            ["https://drive.google.com/viewer/thumb?ds=thumb3&w=400", "https://contribution.usercontent.google.com/download?c=3&filename=dataset_random.custom&opi=3"]
        ]
    ]];
    const extracted = attachments.extractUserFiles(payload);
    assert.strictEqual(extracted.length, 3);
    assert.strictEqual(extracted[0].fileName, 'config.json');
    assert.strictEqual(extracted[1].fileName, 'notes.txt');
    assert.strictEqual(extracted[2].fileName, 'dataset_random.custom');
});

test('prompt URLs and Google Docs editor links are not downloadable attachments', () => {
    assert.deepStrictEqual(attachments.extractUserFiles([
        ['https://docs.google.com/document/d/example/edit?tab=t.0 这个是我drive里面的文档，你能编辑么'],
        ['https://docs.google.com/document/d/example/edit'],
        ['https://drive.google.com/file/d/example/view 请帮我读一下']
    ]), []);
});

test('shopping and lmdx widget references are not downloadable image files', () => {
    const shopping = 'http://googleusercontent.com/shopping_content/11889587029331890754';
    const widget = 'http://googleusercontent.com/lmdx_image/894535722';
    assert.deepStrictEqual(attachments.extractImageEvidence([[shopping, 640, 480], [widget, 700, 280]]), []);
    assert.deepStrictEqual(attachments.extractUserFiles([[shopping], [widget]]), []);
    const images = attachments.extractImageEvidence([['https://encrypted-tbn0.gstatic.com/images?q=real', 700, 280]]);
    assert.equal(images.length, 1);
    assert.equal(images[0].sourceEvidence?.detectorKind, 'extractImages [url,w,h]');
});

// --- From regression_lock.test.ts (hookCredentials & parser wire helpers) ---
function createHookSandbox(sniffProfile?: typeof import('../src/l1/parsers/gemini/dom/accountSniffer.js').sniffUserProfileFromDom) {
    const hookCode = fs.readFileSync(path.resolve(__dirname, '../src/l1/sniffer/gemini/hookCredentials.js'), 'utf8');
    const protocolCode = fs.readFileSync(path.resolve(__dirname, '../src/l1/protocol/gemini/protocol.js'), 'utf8');

    const posted: any[] = [];
    const win: any = {};
    win.postMessage = (msg: any, origin: any) => posted.push({ msg, origin });
    win.addEventListener = () => {};
    win.setInterval = () => 0;
    win.__nextResponseText = '';
    win.fetch = async () => ({
        ok: true,
        clone() {
            return { text: async () => win.__nextResponseText };
        }
    });
    class MockXhr {
        open(_method: string, _url: string): void {}
        send(_body?: string): void {}
        addEventListener(): void {}
    }
    const sandbox: any = {
        window: win,
        location: { origin: 'https://gemini.google.com', href: 'https://gemini.google.com/app', pathname: '/app' },
        document: { querySelectorAll: () => [], addEventListener: () => {} },
        console: { log: () => {}, warn: () => {}, debug: () => {} },
        setTimeout: () => 0,
        URL, URLSearchParams, Request, XMLHttpRequest: MockXhr,
        sniffUserProfileFromDom: sniffProfile ?? require('../src/l1/parsers/gemini/dom/accountSniffer.js').sniffUserProfileFromDom,
        geminiAccountObservation: require('../src/l1/client/gemini/accountObservation.js').geminiAccountObservation,
    };
    vm.createContext(sandbox);
    vm.runInContext(protocolCode, sandbox, { filename: 'protocol.js' });
    // The IIFE exposes the protocol module namespace; the hook receives its
    // actual imports, not the namespace or legacy individually exported constants.
    const protocolModule = sandbox.GeminiProtocol;
    sandbox.GeminiProtocol = protocolModule.GeminiProtocol;
    sandbox.CrossWorldEvents = protocolModule.CrossWorldEvents;
    win.GeminiProtocol = protocolModule.GeminiProtocol;
    vm.runInContext(hookCode, sandbox, { filename: 'hookCredentials.js' });
    posted.length = 0;
    return { posted, win, Xhr: MockXhr };
}

test('hookCredentials - unrelated fetch and XHR traffic does not rescan account profiles', async () => {
    let scans = 0;
    const { posted, win, Xhr } = createHookSandbox(() => {
        scans++;
        return { gaiaId: '10000000001', email: 'alice@example.com' };
    });
    const initialScans = scans;
    assert.ok(initialScans > 0);
    for (let i = 0; i < 20; i++) {
        await win.fetch(new Request(`https://gemini.google.com/assets/chunk-${i}.js`));
        const xhr = new Xhr();
        xhr.open('POST', 'https://gemini.google.com/telemetry');
        xhr.send('event=sample');
    }
    assert.equal(scans, initialScans);
    await win.fetch('https://gemini.google.com/batchexecute?at=token&f.sid=fetch-sid');
    assert.ok(scans > initialScans);
    const afterFetch = scans;
    const xhr = new Xhr();
    xhr.open('POST', 'https://gemini.google.com/batchexecute?at=token&f.sid=xhr-sid');
    xhr.send();
    assert.ok(scans > afterFetch);
    const credentials = posted.filter(p => p.msg.type === 'GEMINI_CREDENTIALS');
    assert.deepEqual(credentials.map(p => p.msg.payload.sid), ['fetch-sid', 'xhr-sid']);
    assert.ok(credentials.every(p => p.msg.payload.accountObservation.providerAccountId === '10000000001'));
});

test('hookCredentials - broadcastBatchexecute filter only relays LIST and DETAIL payloads', async () => {
    const batchexecuteUrl = 'https://gemini.google.com/u/0/batchexecute';
    async function relayedTypesFor(responseText: string): Promise<string[]> {
        const { posted, win } = createHookSandbox();
        win.__nextResponseText = responseText;
        await win.fetch(batchexecuteUrl, { method: 'POST', body: geminiListRequestGen('G_HOOK_GENERIC_PROBE_REQUEST_01') });
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
    assert.strictEqual(await wasRelayed(geminiListGen('G_EXTRACTED_GENERIC_DECOY_LIST_01')), false);
    assert.strictEqual(await wasRelayed(geminiDeleteGen('G_EXTRACTED_REGRESSION_FILTER_DELETE_01')), false);
    assert.strictEqual(await wasRelayed(geminiListGen('G_EXTRACTED_REGRESSION_FILTER_LIST_01')), true);
    assert.strictEqual(await wasRelayed(geminiDetailGen('G_EXTRACTED_REGRESSION_FILTER_DETAIL_01')), true);
});

test('hookCredentials - arbitrary Request-like objects are not treated as browser Requests', async () => {
    const { posted, win } = createHookSandbox();
    win.__nextResponseText = geminiListGen('G_EXTRACTED_REGRESSION_REQUEST_LIST_01');
    class MockRequest {
        url: string;
        body: any;
        constructor(url: string, init?: any) {
            this.url = url;
            this.body = init?.body;
        }
        toString() {
            return '[object Request]';
        }
    }
    const req = new MockRequest('https://gemini.google.com/u/0/batchexecute?at=dummy_at&f.sid=dummy_sid', { body: geminiListRequestGen('G_HOOK_MALFORMED_LIST_REQUEST_01') });
    await win.fetch(req as any, { method: 'POST', body: geminiListRequestGen('G_HOOK_MALFORMED_LIST_REQUEST_01') });
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(posted.length, 0);
    await win.fetch('https://gemini.google.com/u/0/batchexecute?at=dummy_at&f.sid=dummy_sid', { method: 'POST', body: geminiListRequestGen('G_HOOK_MALFORMED_LIST_REQUEST_01') });
    await new Promise(r => setTimeout(r, 50));
    assert.ok(posted.length > 0);
    assert.ok(posted.some(p => p.msg.type === 'GEMINI_CREDENTIALS'));
});

test('hookCredentials - real Request inputs preserve list cursor context', async () => {
    const { posted, win } = createHookSandbox();
    win.__nextResponseText = geminiListGen('G_EXTRACTED_REGRESSION_CURSOR_LIST_01');
    const body = new URLSearchParams(geminiListRequestGen('G_HOOK_LIST_CURSOR_REQUEST_01'));
    await win.fetch(new Request('https://gemini.google.com/u/0/batchexecute', { method: 'POST', body }));
    await new Promise(r => setTimeout(r, 50));
    const relay = posted.find(p => p.msg.type === 'GEMINI_NETWORK_BATCHEXECUTE');
    assert.deepEqual(JSON.parse(JSON.stringify(relay.msg.payload.listRequest)), { streamId: 'recent', requestCursor: 'cursor' });
    assert.equal(relay.msg.payload.truncated, false);
    assert.ok(relay.msg.payload.requestedAt > 0);
});

test('audit fix: robustFirstPayload preserves , null , and control characters inside user content strings', () => {
    const testContent = 'Special test message with , null , in code and [brackets]';
    const text = geminiDetailGen('G_EXTRACTED_REGRESSION_PARSER_DETAIL_01');
    const parsed = decodeGeminiDetail(text, 'testid1234567890ab');
    assert.ok(parsed);
    assert.ok(parsed.messages && parsed.messages.length > 0);
    assert.strictEqual(parsed.messages[0].content, testContent);
});

test('P2 regression: robustFirstPayload retains all 601 entries in a large multiline payload', () => {
    const lines = [")]}'", '['];
    for (let i = 0; i < 600; i++) {
        lines.push(`  ["turn_${i}", "user query with [nested bracket] ${i}", "response_${i}"],`);
    }
    lines.push('  ["final_turn", "query", "answer"]');
    lines.push(']');
    const result = Extractors.robustFirstPayload(lines.join('\n'));
    assert.ok(Array.isArray(result));
    assert.strictEqual(result.length, 601);
});

test('P2 regression: robustFirstPayload handles strings containing brackets without corrupting structure', () => {
    const jsonStr = geminiListGen('G_REGRESSION_BRACKET_TITLE_LIST_01');
    const res = Extractors.robustFirstPayload(jsonStr);
    assert.ok(Array.isArray(res));
    assert.strictEqual(res.length, 1);
    assert.ok(Array.isArray(res[0]));
    assert.strictEqual(res[0][0], 'wrb.fr');
    assert.strictEqual(res[0][1], 'MaZiqc');
});

test('audit fix: isRealTitle fallback filters invalid titles properly', () => {
    assert.strictEqual(isRealTitle('Sign in with Google'), false);
    assert.strictEqual(isRealTitle('未命名对话(3)', 'c_123'), false);
    assert.strictEqual(isRealTitle('搜索'), false);
    assert.strictEqual(isRealTitle('Valid Chat Title 2026', 'c_123'), true);
});
