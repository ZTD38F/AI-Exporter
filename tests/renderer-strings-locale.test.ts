import { fixtureKey, fixtureAccountFor } from './helpers/domainFixture.js';
import { restoreDomainSnapshot } from '../src/l2/runtimeValidation.js';
export {};
const test = require('node:test');
const assert = require('node:assert');

const { getRendererStrings } = require('../src/l4/format/shared/renderStrings.js');
const { composeDomainDocument } = require('../src/l3b/compose/composeDomainDocument.js');
const { renderTypstFixture } = require('./helpers/renderTypstFixture.js');
const { renderDocumentHtml } = require('../src/l4/format/html/renderHtml.js');

function domainFixture(messages: any[], extra: any = {}) {
    const createdAt = require('../src/l1/parsers/shared/time.js').normalizeTimestamp('createdAt' in extra ? extra.createdAt : Date.parse('2026-09-20T10:00:00Z'));
    const updatedAt = require('../src/l1/parsers/shared/time.js').normalizeTimestamp(extra.updatedAt);
    return restoreDomainSnapshot({ index: { key: fixtureKey(String('c1'), 'gemini'),   title: 'Test convo', titleSource: "derived",
        ...(createdAt !== undefined ? { createdAt } : {}), ...(updatedAt !== undefined ? { updatedAt } : {}) },
        detail: { key: fixtureKey(String('c1'), 'gemini'), quality: { status: 'unknown' }, assets: extra.assets ?? [], messages } });
}

function msg(blocks: any[]) {
    return { id: 'm1', role: 'assistant', content: blocks };
}

const opts = {};

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
        { type: 'unknown', sourceType: 'gemini.mystery', text: 'Mystery content' },
        { type: 'math', source: 'x^2' },
    ];
    const b = domainFixture([{ ...msg(blocks), reasoning: [{ type: 'paragraph', children: [{ type: 'text', text: 'Visible reasoning' }] }] }]);
    const { payload } = renderTypstFixture(composeDomainDocument(b, fixtureAccountFor(b)), {}, { ...opts, locale: 'zh' });
    const nodes = payload.messages[0].blocks;
    const thought = nodes.find((n: any) => n.type === 'note' && n.label === 'Thinking Process');
    assert.ok(thought, 'Composer reasoning title stays fixed while renderer chrome is localized');
    const unknown = nodes.find((n: any) => n.type === 'unknown');
    assert.ok(unknown.label.startsWith('不支持的内容'));
    const math = nodes.find((n: any) => n.type === 'math');
    assert.ok(math.fallbackLabel.includes('无法排版'));
});

test('typst defaults to en when locale omitted', () => {
    const b = domainFixture([{ ...msg([]), reasoning: [{ type: 'paragraph', children: [{ type: 'text', text: 'Visible reasoning' }] }] }]);
    const { payload } = renderTypstFixture(composeDomainDocument(b, fixtureAccountFor(b)), {}, opts);
    const thought = payload.messages[0].blocks.find((n: any) => n.type === 'note');
    assert.strictEqual(thought.label, 'Thinking Process');
});

test('typst zh date unknown is localized', () => {
    const b = domainFixture([msg([])]);
    delete b.index.createdAt;
    const { payload } = renderTypstFixture(composeDomainDocument(b, fixtureAccountFor(b)), {}, { ...opts, locale: 'zh' });
    assert.ok(payload.metadata.includes('日期未知'));
});

test('html uses the same string source', () => {
    const blocks: any[] = [];
    const zh = renderDocumentHtml(composeDomainDocument(domainFixture([{ ...msg(blocks), reasoning: [{ type: 'paragraph', children: [{ type: 'text', text: 'Visible reasoning' }] }] }]), fixtureAccountFor(domainFixture([{ ...msg(blocks), reasoning: [{ type: 'paragraph', children: [{ type: 'text', text: 'Visible reasoning' }] }] }]))), {}, { locale: 'zh' });
    assert.ok(zh.html.includes('Thinking Process'));
    const en = renderDocumentHtml(composeDomainDocument(domainFixture([{ ...msg(blocks), reasoning: [{ type: 'paragraph', children: [{ type: 'text', text: 'Visible reasoning' }] }] }]), fixtureAccountFor(domainFixture([{ ...msg(blocks), reasoning: [{ type: 'paragraph', children: [{ type: 'text', text: 'Visible reasoning' }] }] }]))), {}, { locale: 'en' });
    assert.ok(en.html.includes('Thinking Process'));
});

function roleMsg(role: string, extra: any = {}) {
    return { id: `m-${role}`, role, content: [], ...extra };
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
    ];
    const zh = renderTypstFixture(composeDomainDocument(domainFixture(msgs), fixtureAccountFor(domainFixture(msgs))), {}, { ...opts, locale: 'zh' });
    assert.strictEqual(firstNoteText(zh.payload.messages[0]), '系统消息');
    assert.strictEqual(firstNoteText(zh.payload.messages[1]), '开发者消息');
    assert.strictEqual(firstNoteText(zh.payload.messages[2]), '未知角色');
    const en = renderTypstFixture(composeDomainDocument(domainFixture(msgs), fixtureAccountFor(domainFixture(msgs))), {}, opts);
    assert.strictEqual(firstNoteText(en.payload.messages[0]), 'System message');
    assert.strictEqual(firstNoteText(en.payload.messages[1]), 'Developer message');
    assert.strictEqual(firstNoteText(en.payload.messages[2]), 'Unknown role');
});

test('user/assistant roles get no prefix note', () => {
    const { payload } = renderTypstFixture(composeDomainDocument(domainFixture([roleMsg('user'), roleMsg('assistant')]), fixtureAccountFor(domainFixture([roleMsg('user'), roleMsg('assistant')]))), {}, opts);
    assert.strictEqual(payload.messages[0].blocks.length, 0);
    assert.strictEqual(payload.messages[1].blocks.length, 0);
});
