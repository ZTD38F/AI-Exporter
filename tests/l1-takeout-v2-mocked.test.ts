import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ports, GEMINI_ACCOUNT, CHATGPT_ACCOUNT } from './helpers/l1V2UnitMocks.js';
import { importTakeout } from '../src/l1/imports/takeout/importTakeout.js';
import { createSourceResourceContext } from '../src/l1/resources/sourceResources.js';

beforeEach(() => ports.reset());
const chat = 'source_takeout_123';
const html = '<div class="outer-cell"><a href="https://gemini.google.com/app/' + chat + '">Conversation</a>'
    + '<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">'
    + 'Prompted Draw<br>2026-09-02T12:00:00Z<br><p>Output <img src="picture.png"></p></div></div>';
function archive(read?: () => void): File {
    return { file() {}, files: {
        'Takeout/Gemini/MyActivity.html': {
            _data: { uncompressedSize: html.length }, async: async () => html,
        },
        'Takeout/Gemini/picture.png': {
            _data: { uncompressedSize: 3 },
            async: async () => { read?.(); return Uint8Array.of(4, 5, 6); },
        },
    } } as unknown as File;
}

test('Takeout calls only the frozen v2 Detail ingestion port with keyless source facts', async () => {
    const progress: number[] = [];
    const result = await importTakeout(archive(), GEMINI_ACCOUNT.id, value => progress.push(value));
    assert.equal(result.imported, 1);
    assert.equal(ports.details.length, 1);
    assert.equal(ports.details[0].accountId, GEMINI_ACCOUNT.id);
    assert.equal(ports.details[0].conversationId, chat);
    assert.ok(ports.details[0].detail.messages.length > 0);
    assert.equal('key' in ports.details[0].detail, false);
    assert.equal('key' in (ports.details[0].indexFields ?? {}), false);
    assert.deepEqual(ports.indexes, [], 'Import does not manufacture online list Coverage');
    assert.deepEqual(ports.notifications, [GEMINI_ACCOUNT.id]);
    assert.equal(progress.at(-1), 100);
    assert.ok(progress.every(p => Number.isFinite(p) && p >= 0 && p <= 100));
});

test('accepted Takeout retains same-task ZIP resource readers lazily, not in L2 Domain', async () => {
    const resources = createSourceResourceContext();
    let readCount = 0;
    try {
        ports.detailDecision = { accepted: true, changed: false };
        await importTakeout(archive(() => { readCount++; }), GEMINI_ACCOUNT.id, undefined, resources);
        assert.equal(readCount, 0);
        const admitted = ports.details[0];
        assert.equal(admitted.detail.assets.length, 1);
        const asset = admitted.detail.assets[0];
        const key = { accountId: GEMINI_ACCOUNT.id, conversationId: chat };
        const first = await resources.acquire(key, asset);
        assert.deepEqual(first.bytes, Uint8Array.of(4, 5, 6));
        assert.equal(readCount, 1);
        assert.equal(JSON.stringify(admitted.detail).includes('AQID'), false,
            'resource bytes are not persisted inside a Domain candidate');
    } finally { resources.release(); }
});

test('rejected Takeout Detail never retains archive readers or overrides task resources', async () => {
    const resources = createSourceResourceContext();
    let retained = 0, bytesRead = 0;
    resources.retainParsed = () => { retained++; };
    resources.retain = () => { retained++; };
    try {
        ports.detailDecision = { accepted: false, changed: false };
        await importTakeout(archive(() => { bytesRead++; }), GEMINI_ACCOUNT.id, undefined, resources);
        assert.equal(ports.details.length, 1);
        assert.equal(retained, 0);
        assert.equal(bytesRead, 0);
        assert.equal(ports.deletions.length, 0);
    } finally { resources.release(); }
});

test('Takeout never imports to a foreign provider and propagates failed L2 commits', async () => {
    await assert.rejects(importTakeout(archive(), CHATGPT_ACCOUNT.id), /existing Gemini account/);
    assert.equal(ports.details.length, 0);
    ports.detailError = new Error('mock Detail admission transaction failed');
    await assert.rejects(importTakeout(archive(), GEMINI_ACCOUNT.id),
        /mock Detail admission transaction failed/);
    assert.equal(ports.details.length, 0);
});
