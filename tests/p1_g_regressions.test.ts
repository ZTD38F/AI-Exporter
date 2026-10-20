/**
 * tests/p1_g_regressions.test.ts
 * Regression tests for review group G (type system: contract drift & dead code),
 * P1-090~094 and P1-097~101.
 *
 * Conventions: runtime assertions run under node --test via ts_register (esbuild,
 * no type checking). Type-level assertions use `// @ts-expect-error` in
 * type-only positions (fully erased at runtime) and are verified by
 * `npx tsc --noEmit`, which includes tests/**.
 */
export {};
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

import type { ChatMessage, Conversation, Attachment } from '../src/types/conversation.js';
import type { MessageAction, LiveSaveViaHandlePayload } from '../src/types/messages.js';
import type { BackgroundMessage, BackgroundResponse } from '../src/types/entrypoints.js';

const SRC = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// ---------------------------------------------------------------------------
// P1-090: ChatMessage.thoughts is honestly string | string[]
// parseDetail writes a joined string.
// ---------------------------------------------------------------------------
test('p1_g - P1-090 thoughts accepts both string and string[]', () => {
    const fromParser: ChatMessage = { role: 'model', content: 'hi', thoughts: 'joined\n\nstring' };
    const fromChatgpt: ChatMessage = { role: 'model', content: 'hi', thoughts: ['a', 'b'] };
    assert.strictEqual(fromParser.thoughts, 'joined\n\nstring');
    assert.deepStrictEqual(fromChatgpt.thoughts, ['a', 'b']);
});

// ---------------------------------------------------------------------------
// P1-091: [key: string]: any index signatures removed from core models;
// real runtime fields added instead.
// ---------------------------------------------------------------------------
test('p1_g - P1-091 no index signatures on core models', () => {
    for (const f of ['src/types/conversation.ts', 'src/types/messages.ts']) {
        const code = SRC(f).replace(/\/\/.*$/gm, '');
        assert.ok(!/\[key:\s*string\]:\s*any/.test(code), `${f} must not contain [key: string]: any`);
    }
    // @ts-expect-error - P1-091: undeclared props must be a type error now
    type _NoIndex = Conversation['someUndeclaredProp'];
    // @ts-expect-error - P1-091: same for ChatMessage
    type _NoIndex2 = ChatMessage['anotherUndeclaredProp'];
});

test('p1_g - P1-091 real runtime fields are declared', () => {
    const msg: ChatMessage = {
        role: 'model', content: 'x',
        images: [{ type: 'image', fileName: 'a.png', localName: 'assets/a.png' }],
        thinking: 'legacy thought text',
        attachmentCount: 2,
    };
    const conv: Conversation = {
        id: 'c_1', title: 't', timestamp: 123,
        attachmentCount: 2, messageCount: 5,
        href: 'https://gemini.google.com/app/c_1',
        hasExplicitPrompt: true,
    };
    const att: Attachment = { type: 'image', name: 'alt', isGenerated: true, isImage: true, subDir: 'assets', source: 'takeout' };
    assert.strictEqual(msg.attachmentCount, 2);
    assert.strictEqual(conv.messageCount, 5);
    assert.strictEqual(conv.href, 'https://gemini.google.com/app/c_1');
    assert.strictEqual(att.isGenerated, true);
});

// ---------------------------------------------------------------------------
// P1-092: MessageAction covers the real protocol (incl. the 3 router actions
// and popup's fetchChat); ghost 'startExport' removed.
// ---------------------------------------------------------------------------
test('p1_g - P1-092 MessageAction covers all real actions', () => {
    const actions: MessageAction[] = [
        'syncUpdate', 'scanProgress', 'openOptions', 'getConversationDetail',
        'fetchBatch', 'fetchChat', 'cancelExport', 'downloadAssetDirect',
        'abortSync', 'deepScan', 'stopDeepScan', 'exportProgress', 'ping',
        'openGeminiPage', 'reloadGeminiTab', 'liveSaveViaHandle',
        'getScrollContainer', 'getFileBlob', 'getImageBlob',
    ];
    assert.strictEqual(actions.length, 19);
    assert.ok(actions.includes('getScrollContainer'));
    assert.ok(actions.includes('getFileBlob'));
    assert.ok(actions.includes('getImageBlob'));
    assert.ok(actions.includes('fetchChat'));
    assert.ok(!(actions as string[]).includes('startExport'), 'ghost startExport must stay removed');
});

// ---------------------------------------------------------------------------
// P1-093: LiveSaveViaHandlePayload carries assets (what the coordinator sends
// and the background handler destructures).
// ---------------------------------------------------------------------------
test('p1_g - P1-093 live-save payload includes assets contract', () => {
    const payload: LiveSaveViaHandlePayload = {
        chat: { id: 'c_1', title: 't', timestamp: 1 },
        safeTitle: 't', nid: 'n1',
        assets: [{ fileName: 'a.png', subDir: 'assets', base64: 'eA==' }],
    };
    assert.strictEqual(payload.assets!.length, 1);
    assert.strictEqual(payload.assets![0].fileName, 'a.png');
});

// ---------------------------------------------------------------------------
// P1-094: GeminiRpcError deleted (zero instantiations in src); the live
// error hierarchy (GeminiError base + 3 used subclasses) kept.
// ---------------------------------------------------------------------------
test('p1_g - P1-094 GeminiRpcError is gone, hierarchy intact', () => {
    const errors = require('../src/types/errors.js');
    assert.strictEqual(errors.GeminiRpcError, undefined, 'dead class must stay deleted');
    assert.strictEqual(typeof errors.GeminiError, 'function');
    for (const name of ['ExportPipelineError', 'TakeoutParseError', 'StorageError']) {
        const inst = new errors[name]('x');
        assert.ok(inst instanceof errors.GeminiError, `${name} extends GeminiError`);
    }
    assert.ok(!/GeminiRpcError/.test(SRC('src/types/errors.ts')), 'no resurrection in source');
});

// ---------------------------------------------------------------------------
// P1-097: types/wire.ts deleted; index.ts no longer re-exports it;
// README no longer claims the false "wire type safety" story.
// ---------------------------------------------------------------------------
test('p1_g - P1-097 wire.ts deleted and unreferenced', () => {
    assert.ok(!fs.existsSync(path.join(__dirname, '../src/types/wire.ts')), 'wire.ts must stay deleted');
    assert.ok(!/wire/.test(SRC('src/types/index.ts')), 'index.ts must not mention wire');
    const readme = SRC('src/README.md');
    assert.ok(!/src\/types\/wire\.ts/.test(readme), 'README must not reference src/types/wire.ts');
    assert.ok(!/isBatchexecuteChunk/.test(readme), 'README must not cite the dead guards');
});

// ---------------------------------------------------------------------------
// P1-098: entrypoints tightened — exact action union, no `| string`
// dilution, any -> unknown on response/message payloads.
// ---------------------------------------------------------------------------
test('p1_g - P1-098 entrypoints use exact unions and unknown', () => {
    const src = SRC('src/types/entrypoints.ts');
    assert.ok(!/\|\s*string/.test(src.replace(/'[^']*'/g, '')), 'no `| string` dilution outside literals');
    assert.ok(!/: any/.test(src), 'no `any` fields left');
    // @ts-expect-error - P1-098: action must reject unknown literals
    const _bad: BackgroundMessage = { action: 'bogusAction' };
    void _bad;
    // _IsAny<unknown> = false, so assigning `true` errors; if the field were
    // `any` again, _IsAny<any> = true and the @ts-expect-error below would go
    // unused, failing tsc.
    type _IsAny<T> = 0 extends (1 & T) ? true : false;
    // @ts-expect-error - P1-098: data must be unknown, not any
    const _d: _IsAny<BackgroundResponse['data']> = true;
    void _d;
    // @ts-expect-error - P1-098: payload must be unknown, not any
    const _p: _IsAny<BackgroundMessage['payload']> = true;
    void _p;
    // @ts-expect-error - P1-098: results must be unknown[], not any[]
    const _r: _IsAny<BackgroundResponse['results']> = true;
    void _r;
});

// ---------------------------------------------------------------------------
// P1-099: the ~17 dead `declare var X: any` globals removed from global.d.ts.
// ---------------------------------------------------------------------------
test('p1_g - P1-099 dead any-globals removed', () => {
    const src = SRC('src/types/global.d.ts');
    for (const name of [
        'BadgeView', 'PageObserver', 'MessageRouter', 'MessageBridge', 'SyncEngine',
        'DomScraper', 'AssetFetcher', 'OptionsInit', 'OptionsExport', 'OptionsSync',
        'OptionsTakeout', 'OptionsSettings', 'DefaultApiClient', 'DefaultTabService',
        'I18n', 'JSZip',
    ]) {
        assert.ok(
            !new RegExp(`declare\\s+var\\s+${name}\\s*:\\s*any`).test(src),
            `declare var ${name}: any must stay deleted`
        );
    }
    // The one global that must exist is now precisely typed, not any.
    assert.ok(/declare\s+var\s+GeminiAPIClient:\s*import\(/.test(src), 'GeminiAPIClient keeps a precise global type');
    // @ts-expect-error - P1-099: dead ambient global must not resolve
    type _NoBadgeView = typeof BadgeView;
    // NOTE: bare `I18n` still resolves via `declare global { var I18n: any }`
    // inside takeoutHtmlParser.ts / takeoutParser.ts (their own modules, out
    // of G scope) — global.d.ts itself no longer declares it (asserted above).
});

// ---------------------------------------------------------------------------
// P1-100: dead model types ThoughtBlock / CitationSource deleted.
// ---------------------------------------------------------------------------
test('p1_g - P1-100 ThoughtBlock and CitationSource deleted', () => {
    const src = SRC('src/types/conversation.ts');
    assert.ok(!/interface ThoughtBlock/.test(src), 'ThoughtBlock must stay deleted');
    assert.ok(!/interface CitationSource/.test(src), 'CitationSource must stay deleted');
    // @ts-expect-error - P1-100: no such export anymore
    type _TB = import('../src/types/conversation.js').ThoughtBlock;
    // @ts-expect-error - P1-100: no such export anymore
    type _CS = import('../src/types/conversation.js').CitationSource;
});

// ---------------------------------------------------------------------------
// P1-101: dead `Attachment` import removed from messages.ts.
// ---------------------------------------------------------------------------
test('p1_g - P1-101 dead Attachment import removed from messages.ts', () => {
    const src = SRC('src/types/messages.ts');
    assert.ok(!/import type \{[^}]*\bAttachment\b/.test(src), 'unused Attachment import must stay removed');
    // Module still loads cleanly (it is types-only, so exports are empty).
    assert.ok(require('../src/types/messages.js') !== undefined);
});
