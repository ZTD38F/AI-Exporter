export {};
const test = require('node:test');
const assert = require('node:assert');

const { getRendererStrings } = require('../src/core/export/canonical/rendererStrings.js');
const { toTypstPayload } = require('../src/core/export/typst/payload.js');
const { renderCanonicalHtml } = require('../src/core/export/canonical/renderCanonicalHtml.js');

function bundle(messages: any[], extra: any = {}) {
    return {
        schemaVersion: 1,
        conversation: {
            key: { providerId: 'gemini', accountId: 't', conversationId: 'c1' },
            title: 't',
            createdAt: '2026-09-20T10:00:00Z',
            messages,
            ...extra,
        },
        assets: [],
        citations: [],
    };
}

function msg(blocks: any[]) {
    return { id: 'm1', role: 'model', blocks };
}

const opts = { assetPath: (_a: any) => undefined };

test('getRendererStrings returns zh and en copies', () => {
    const zh = getRendererStrings('zh');
    const en = getRendererStrings('en');
    assert.strictEqual(zh.thinkingSummary, '思考摘要');
    assert.strictEqual(zh.sources, '来源');
    assert.strictEqual(zh.sizeUnknown, '大小未知');
    assert.strictEqual(zh.dateUnknown, '日期未知');
    assert.strictEqual(zh.unsupportedContent, '不支持的内容');
    assert.ok(zh.mathFallback.includes('无法排版'));
    assert.strictEqual(en.thinkingSummary, 'Thinking Summary');
    assert.strictEqual(en.sources, 'Sources');
});

test('typst zh locale localizes chrome copy', () => {
    const blocks = [
        { id: 't1', type: 'thought', kind: 'summary', blocks: [] },
        { id: 'u1', type: 'unknown', sourceType: 'gemini.mystery', text: 'Mystery content' },
        { id: 'm1', type: 'math', source: 'x^2' },
    ];
    const b = bundle([msg(blocks)]);
    const { payload } = toTypstPayload(b, { ...opts, locale: 'zh' });
    const nodes = payload.messages[0].blocks;
    const thought = nodes.find((n: any) => n.type === 'note' && n.label === '思考摘要');
    assert.ok(thought, 'thought label localized');
    const unknown = nodes.find((n: any) => n.type === 'unknown');
    assert.ok(unknown.label.startsWith('不支持的内容'));
    const math = nodes.find((n: any) => n.type === 'math');
    assert.ok(math.fallbackLabel.includes('无法排版'));
});

test('typst defaults to en when locale omitted', () => {
    const b = bundle([msg([{ id: 't1', type: 'thought', kind: 'summary', blocks: [] }])]);
    const { payload } = toTypstPayload(b, opts);
    const thought = payload.messages[0].blocks.find((n: any) => n.type === 'note');
    assert.strictEqual(thought.label, 'Thinking Summary');
});

test('typst zh date unknown is localized', () => {
    const b = bundle([msg([])]);
    delete b.conversation.createdAt;
    const { payload } = toTypstPayload(b, { ...opts, locale: 'zh' });
    assert.strictEqual(payload.date, '日期未知');
});

test('html uses the same string source', () => {
    const blocks = [
        { id: 't1', type: 'thought', kind: 'summary', blocks: [] },
    ];
    const zh = renderCanonicalHtml(bundle([msg(blocks)]), {});
    assert.ok(zh.html.includes('思考摘要'));
    const en = renderCanonicalHtml(bundle([msg(blocks)]), { lang: 'en' });
    assert.ok(en.html.includes('Thinking Summary'));
});

function roleMsg(role: string, extra: any = {}) {
    return { id: `m-${role}-${Math.random().toString(36).slice(2, 8)}`, role, blocks: [], ...extra };
}

function firstNoteText(message: any) {
    return message.blocks[0].children[0].text;
}

test('role prefix strings live in the string table (en + zh)', () => {
    const en = getRendererStrings('en');
    assert.strictEqual(en.systemMessage, 'System message');
    assert.strictEqual(en.developerMessage, 'Developer message');
    assert.strictEqual(en.unknownRole, 'Unknown role');
    const zh = getRendererStrings('zh');
    assert.strictEqual(zh.systemMessage, '系统消息');
    assert.strictEqual(zh.developerMessage, '开发者消息');
    assert.strictEqual(zh.unknownRole, '未知角色');
});

test('typst localizes role prefix notes', () => {
    const msgs = [
        roleMsg('system'),
        roleMsg('developer'),
        roleMsg('unknown'),
        roleMsg('unknown', { author: { rawRole: 'plugin-x' } }),
    ];
    const zh = toTypstPayload(bundle(msgs), { ...opts, locale: 'zh' });
    assert.strictEqual(firstNoteText(zh.payload.messages[0]), '系统消息');
    assert.strictEqual(firstNoteText(zh.payload.messages[1]), '开发者消息');
    assert.strictEqual(firstNoteText(zh.payload.messages[2]), '未知角色');
    assert.strictEqual(firstNoteText(zh.payload.messages[3]), '未知角色: plugin-x');
    const en = toTypstPayload(bundle(msgs), opts);
    assert.strictEqual(firstNoteText(en.payload.messages[0]), 'System message');
    assert.strictEqual(firstNoteText(en.payload.messages[1]), 'Developer message');
    assert.strictEqual(firstNoteText(en.payload.messages[2]), 'Unknown role');
    assert.strictEqual(firstNoteText(en.payload.messages[3]), 'Unknown role: plugin-x');
});

test('user/assistant roles get no prefix note', () => {
    const { payload } = toTypstPayload(bundle([roleMsg('user'), roleMsg('model')]), opts);
    assert.strictEqual(payload.messages[0].blocks.length, 0);
    assert.strictEqual(payload.messages[1].blocks.length, 0);
});
