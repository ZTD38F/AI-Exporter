export {};
const test = require('node:test');
const assert = require('node:assert');

const { applyExportTitleWriteback } = require('../src/core/engine/export/exportOrchestrator.js');

const clone = (o: any) => JSON.parse(JSON.stringify(o));

test('low-authority list snapshot does NOT downgrade stored rpc title', () => {
    const existing = clone({ id: 'c_9f2ab41c', title: '线上RPC权威标题内容', titleSource: 'rpc', titles: { rpc: '线上RPC权威标题内容' } });
    const listC = { id: 'c_9f2ab41c', title: 'Takeout旧标题内容', titleSource: 'takeout', titles: { takeout: 'Takeout旧标题内容' } };
    applyExportTitleWriteback(existing, listC);
    assert.strictEqual(existing.title, '线上RPC权威标题内容');
    assert.strictEqual(existing.titleSource, 'rpc');
    // The takeout slot is still recorded on the record, just not resolved.
    assert.strictEqual(existing.titles.takeout, 'Takeout旧标题内容');
    assert.strictEqual(existing.titles.rpc, '线上RPC权威标题内容');
});

test('higher-authority incoming title IS adopted (upgrade path)', () => {
    const existing = clone({ id: 'c_9f2ab41c', title: 'Takeout旧标题内容', titleSource: 'takeout', titles: { takeout: 'Takeout旧标题内容' } });
    const listC = { id: 'c_9f2ab41c', title: '线上RPC新标题内容', titleSource: 'rpc', titles: { rpc: '线上RPC新标题内容' } };
    applyExportTitleWriteback(existing, listC);
    assert.strictEqual(existing.title, '线上RPC新标题内容');
    assert.strictEqual(existing.titleSource, 'rpc');
});

test('same-tier incoming title overwrites (authority >= keeps working)', () => {
    const existing = clone({ id: 'c_9f2ab41c', title: 'DOM旧标题内容', titleSource: 'dom', titles: { dom: 'DOM旧标题内容' } });
    const listC = { id: 'c_9f2ab41c', title: 'DOM新标题内容', titleSource: 'dom', titles: { dom: 'DOM新标题内容' } };
    applyExportTitleWriteback(existing, listC);
    assert.strictEqual(existing.title, 'DOM新标题内容');
    assert.strictEqual(existing.titleSource, 'dom');
});

test('legacy-shaped stored record (no titles slots) is protected by seeding', () => {
    const existing = clone({ id: 'c_9f2ab41c', title: '线上RPC标题内容', titleSource: 'rpc' });
    const listC = { id: 'c_9f2ab41c', title: 'Takeout旧标题内容', titleSource: 'takeout', titles: { takeout: 'Takeout旧标题内容' } };
    applyExportTitleWriteback(existing, listC);
    assert.strictEqual(existing.title, '线上RPC标题内容');
    assert.strictEqual(existing.titleSource, 'rpc');
    assert.strictEqual(existing.titles.rpc, '线上RPC标题内容');
});

test('placeholder stored title does not trigger gratuitous titleSource rewrite', () => {
    const existing = clone({ id: 'c_9f2ab41c', title: '未命名对话', titleSource: 'legacy' });
    const listC = { id: 'c_9f2ab41c' };
    applyExportTitleWriteback(existing, listC);
    assert.strictEqual(existing.title, '未命名对话');
    assert.strictEqual(existing.titleSource, 'legacy');
});

test('null-safe: missing listC or existing', () => {
    const existing = { id: 'c_x1', title: '标题内容', titleSource: 'rpc' };
    assert.strictEqual(applyExportTitleWriteback(existing, null), existing);
    assert.strictEqual(applyExportTitleWriteback(existing, undefined), existing);
    assert.strictEqual(applyExportTitleWriteback(null, { title: 't' }), null);
});
