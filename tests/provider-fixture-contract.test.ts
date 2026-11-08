import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fixtureCatalog } from './fixtures/providers/catalog.js';
import { inventory, sources } from '../scripts/audit-provider-fixtures.cjs';
import { detailGen, treeGen } from './fixtures/providers/grokDetail.js';
import { listGen } from './fixtures/providers/grokList.js';

test('provider fixture references resolve and generators never execute a production parser', () => {
    assert.deepEqual(inventory().unresolved, []);
    const folder = join(__dirname, 'fixtures/providers');
    for (const name of sources(folder).filter((name: string) => name.endsWith('.ts'))) {
        const source = readFileSync(name, 'utf8');
        const runtimeImports = [...source.matchAll(/import\s+(?!type\b)[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/g)];
        assert.deepEqual(runtimeImports.filter(match => match[1].includes('/src/')).map(match => match[1]), [], name);
        assert.doesNotMatch(source, /(?:require\s*\(|import\s*\()\s*['"][^'"]*\/src\//, name);
    }
});

test('Grok endpoint fixtures isolate provider mutations from subsequent reads', () => {
    const detail = detailGen('GR_DETAIL_TEXT_01');
    const image = detailGen('GR_DETAIL_IMAGE_01');
    detail.bodies.responses.pop();
    detail.metadata.conversation.title = 'changed';
    image.tree.responseNodes.pop();
    const tree = treeGen('GR_TREE_INFLIGHT_01');
    tree.responseNodes.pop();
    const list = listGen('GR_LIST_TERMINAL_01');
    list.conversations[0].title = 'changed';
    assert.equal(detailGen('GR_DETAIL_TEXT_01').bodies.responses.length, 2);
    assert.equal(detailGen('GR_DETAIL_IMAGE_01').tree.responseNodes.length, 6);
    assert.equal(treeGen('GR_TREE_STABLE_01').responseNodes.length, 2);
    assert.deepEqual(treeGen('GR_TREE_STABLE_01').inflightResponses, []);
    assert.equal(listGen('GR_LIST_TERMINAL_01').conversations[0].title, 'Exporter Integration Test Comparison Table');
});


test('fixture provenance covers every fixed key with existing evidence and honest source units', () => {
    const keys = fixtureCatalog.map(entry => entry.key);
    assert.equal(new Set(keys).size, keys.length, 'metadata must have one owner per key');
    assert.deepEqual([...keys].sort(), inventory().fixtures.map((entry: { key: string }) => entry.key).sort());
    for (const { key, origin } of fixtureCatalog) {
        if (origin.kind === 'synthetic') {
            assert.ok(origin.purpose.trim(), key);
            continue;
        }
        const evidence = origin.kind === 'captured' ? [origin.source] : origin.sources;
        assert.ok(evidence.length, key);
        for (const file of evidence) {
            assert.ok(file.startsWith('tests/fixtures/'), key + ': ' + file);
            assert.ok(existsSync(resolve(__dirname, '..', file)), key + ': ' + file);
        }
        assert.ok((origin.kind === 'captured' ? origin.unit : origin.changes).trim(), key);
    }
    const origin = (key: string) => fixtureCatalog.find(entry => entry.key === key)?.origin;
    assert.equal(origin('G_NATIVE_CAPTURE_DELETE_RESPONSE_01')?.kind, 'captured');
    assert.equal(origin('G_STRUCTURED_CITATIONS_10')?.kind, 'derived');
    assert.equal(origin('G_STREAM_CAPTURED_ANSWERED_01')?.kind, 'derived');
    assert.equal(origin('C_CAPTURE_EMPTY_DETAIL_01')?.kind, 'synthetic');
    assert.equal(origin('CL_L1_SOURCE_SELECTED_BRANCH_01')?.kind, 'synthetic');
    assert.equal(origin('GR_TREE_INFLIGHT_01')?.kind, 'derived');
});
