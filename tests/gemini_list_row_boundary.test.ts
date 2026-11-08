import test from 'node:test';
import assert from 'node:assert/strict';
import { listGen as geminiListGen } from './fixtures/providers/gemini.js';
import { decodeGeminiListRow, parseList } from '../src/l1/parsers/gemini/rpc/parseList.js';
import { findListConversationMetadata } from '../src/l1/parsers/gemini/rpc/listMetadata.js';
import { GeminiResponseEnvelope } from '../src/l1/parsers/gemini/rpc/responseEnvelope.js';

function sourceRows(key: Parameters<typeof geminiListGen>[0]): unknown[] {
    const { inner } = new GeminiResponseEnvelope(geminiListGen(key)).payload('MaZiqc');
    assert.ok(Array.isArray(inner), 'LIST RPC must contain a decoded inner array');
    const rows: unknown = Array.isArray(inner[2]) ? inner[2] : inner[1];
    assert.ok(Array.isArray(rows), 'fixture must contain LIST rows');
    return rows;
}

test('LIST row boundary turns source fields into typed facts once', () => {
    const row = decodeGeminiListRow(sourceRows('G_LIST_SOURCE_BOUNDARY_07')[0]);
    assert.deepEqual(row, {
        id: 'boundary123', title: 'Source title', createdAt: null,
        updatedAt: 1700000060000, orderTime: 1700000060000
    });
    const page = parseList(geminiListGen('G_LIST_SOURCE_BOUNDARY_07'));
    assert.deepEqual(page.conversations, [{
        id: 'boundary123', title: 'Source title', titleSource: 'provider',
        updatedAt: 1700000060000
    }]);
    assert.deepEqual(page.pageEvidence.keys, [{ id: 'boundary123', time: 1700000060000 }]);
    assert.equal(page.pageEvidence.valid, true);
    assert.equal(page.pageEvidence.ordered, true);
});

test('malformed LIST rows are skipped without certifying a complete page', () => {
    const rows = sourceRows('G_BOUNDARY_LIST_01');
    for (const row of rows.slice(0, 3)) assert.equal(decodeGeminiListRow(row), null);
    const idOnly = decodeGeminiListRow(rows[3]);
    assert.equal(idOnly?.id, 'missingtitle123');
    assert.equal(idOnly?.title, '');
    assert.equal(idOnly?.updatedAt, null);
    assert.equal(idOnly?.orderTime, 0);

    const parsed = parseList(geminiListGen('G_BOUNDARY_LIST_01'));
    assert.equal(parsed.conversations.length, 4);
    assert.equal(parsed.pageEvidence.valid, false);
    assert.equal(parsed.pageEvidence.ordered, false);
    // A key and its timestamp must always describe the same decoded row.
    assert.deepEqual(parsed.pageEvidence.keys.map(item => item.id), parsed.conversations.map(item => item.id));
});

test('ordering evidence requires official timestamps, not alternative or inferred dates', () => {
    const row = decodeGeminiListRow(sourceRows('G_PAGE_OBSERVATION_03')[0]);
    assert.equal(row?.updatedAt, null);
    assert.equal(row?.orderTime, 0);
    const result = parseList(geminiListGen('G_PAGE_OBSERVATION_03'));
    assert.equal(result.pageEvidence.valid, true);
    assert.equal(result.pageEvidence.ordered, false);
    assert.deepEqual(result.pageEvidence.keys, [{ id: 'abcdef123', time: 0 }]);
});

test('detail-side LIST metadata lookup reuses validated row fields', () => {
    const top = new GeminiResponseEnvelope(geminiListGen('G_LIST_SOURCE_BOUNDARY_07'));
    assert.deepEqual(findListConversationMetadata(top, 'boundary123'), {
        id: 'boundary123', title: 'Source title', titleSource: 'rpc',
        updatedAt: 1700000060000
    });
    assert.equal(findListConversationMetadata(top, 'other'), undefined);
    assert.equal(findListConversationMetadata(new GeminiResponseEnvelope(geminiListGen('G_LIST_SOURCE_BOUNDARY_08_2')), 'unknown'), undefined);
});
