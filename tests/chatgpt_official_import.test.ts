export {};
const test = require('node:test');
const assert = require('node:assert');

const {
    parseChatGPTOfficialExportZip
} = require('../src/core/provider/chatgpt/officialImport.js');

function installJSZip() {
    (global as any).JSZip = require('../lib/jszip.min.js');
    return new (global as any).JSZip();
}

test('ChatGPT official import - reads conversations.json and preserves other archive entries neutrally', async () => {
    const zip = installJSZip();
    zip.file('conversations.json', JSON.stringify([
        { id: 'c1', title: 'One', update_time: 1700000000, mapping: {} },
        { id: 'c2', title: 'Two', update_time: 1700000100, mapping: {} }
    ]));
    zip.file('user.json', JSON.stringify({ email: 'private@example.com' }));
    zip.file('files/document.pdf', new Uint8Array([1, 2, 3]));

    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const result = await parseChatGPTOfficialExportZip(buffer);

    assert.strictEqual(result.importIntegrityComplete, true);
    assert.deepStrictEqual(result.conversationJsonFiles, ['conversations.json']);
    assert.deepStrictEqual(result.conversations.map((x: any) => x.id), ['c1', 'c2']);
    assert.strictEqual(result.conflicts.length, 0);
    assert.strictEqual(result.errors.length, 0);
    assert.deepStrictEqual(
        result.archiveEntries.map((x: any) => x.path).sort(),
        ['files/document.pdf', 'user.json']
    );
});

test('ChatGPT official import - discovers numbered conversation JSON files and exact duplicate ids do not become conflicts', async () => {
    const zip = installJSZip();
    const same = { id: 'c-same', title: 'Same', update_time: 1700000000, mapping: {} };

    zip.file('export/conversations-000.json', JSON.stringify([
        same,
        { id: 'c-a', title: 'A', mapping: {} }
    ]));
    zip.file('export/conversations-001.json', JSON.stringify([
        same,
        { id: 'c-b', title: 'B', mapping: {} }
    ]));

    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const result = await parseChatGPTOfficialExportZip(buffer);

    assert.deepStrictEqual(result.conversationJsonFiles, [
        'export/conversations-000.json',
        'export/conversations-001.json'
    ]);
    assert.deepStrictEqual(
        result.conversations.map((x: any) => x.id),
        ['c-a', 'c-b', 'c-same']
    );
    assert.strictEqual(result.conflicts.length, 0);
    assert.strictEqual(result.importIntegrityComplete, true);
    assert.strictEqual(result.conversationSources['c-same'].length, 2);
});

test('ChatGPT official import - conflicting duplicate ids select newest variant deterministically and remain explicit conflicts', async () => {
    const zip = installJSZip();

    zip.file('conversations-000.json', JSON.stringify([
        {
            id: 'c-conflict',
            title: 'Older',
            update_time: 1700000000,
            mapping: { a: 1 }
        }
    ]));
    zip.file('conversations-001.json', JSON.stringify([
        {
            id: 'c-conflict',
            title: 'Newer',
            updated_at: '2023-11-14T22:15:00.000Z',
            mapping: { a: 2 }
        }
    ]));

    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const result = await parseChatGPTOfficialExportZip(buffer);

    assert.strictEqual(result.conversations.length, 1);
    assert.strictEqual(result.conversations[0].title, 'Newer');
    assert.strictEqual(result.conflicts.length, 1);
    assert.strictEqual(result.conflicts[0].conversationId, 'c-conflict');
    assert.strictEqual(
        result.conflicts[0].selectedSource,
        'conversations-001.json#0'
    );
    assert.deepStrictEqual(result.conflicts[0].variantSources, [
        'conversations-000.json#0',
        'conversations-001.json#0'
    ]);
    assert.strictEqual(result.importIntegrityComplete, false);
});

test('ChatGPT official import - timestamp comparison normalizes Unix seconds versus millisecond/ISO forms', async () => {
    const zip = installJSZip();
    zip.file('conversations-000.json', JSON.stringify([
        {
            id: 'c-time',
            title: 'Seconds later',
            update_time: 1700000200,
            mapping: { v: 2 }
        }
    ]));
    zip.file('conversations-001.json', JSON.stringify([
        {
            id: 'c-time',
            title: 'ISO earlier',
            updated_at: '2023-11-14T22:15:00.000Z',
            mapping: { v: 1 }
        }
    ]));

    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const result = await parseChatGPTOfficialExportZip(buffer);

    assert.strictEqual(result.conversations[0].title, 'Seconds later');
    assert.strictEqual(result.conflicts.length, 1);
    assert.strictEqual(
        result.conflicts[0].selectedSource,
        'conversations-000.json#0'
    );
});

test('ChatGPT official import - object wrapper with conversations[] is accepted', async () => {
    const zip = installJSZip();
    zip.file('nested/conversations.json', JSON.stringify({
        conversations: [
            { conversation_id: 'wrapped-1', title: 'Wrapped', mapping: {} }
        ]
    }));

    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const result = await parseChatGPTOfficialExportZip(buffer);

    assert.strictEqual(result.conversations.length, 1);
    assert.strictEqual(result.conversations[0].conversation_id, 'wrapped-1');
    assert.deepStrictEqual(result.conversationSources['wrapped-1'], [
        'nested/conversations.json#0'
    ]);
});

test('ChatGPT official import - missing ids and schema drift are errors, never silently skipped as complete', async () => {
    const zip = installJSZip();
    zip.file('conversations-000.json', JSON.stringify([
        { title: 'No id', mapping: {} },
        { id: 'good', title: 'Good', mapping: {} }
    ]));
    zip.file('conversations-001.json', JSON.stringify({
        unexpected: true
    }));

    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const result = await parseChatGPTOfficialExportZip(buffer);

    assert.deepStrictEqual(result.conversations.map((x: any) => x.id), ['good']);
    assert.strictEqual(result.importIntegrityComplete, false);
    assert.ok(result.errors.some((e: any) => e.code === 'CONVERSATION_ID_MISSING'));
    assert.ok(result.errors.some((e: any) => e.code === 'CONVERSATION_SCHEMA_DRIFT'));
});

test('ChatGPT official import - invalid JSON is explicit partial state', async () => {
    const zip = installJSZip();
    zip.file('conversations.json', '{not-json');

    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const result = await parseChatGPTOfficialExportZip(buffer);

    assert.strictEqual(result.conversations.length, 0);
    assert.strictEqual(result.importIntegrityComplete, false);
    assert.strictEqual(result.errors[0].code, 'INVALID_CONVERSATION_JSON');
});

test('ChatGPT official import - archive without conversation JSON is rejected', async () => {
    const zip = installJSZip();
    zip.file('user.json', JSON.stringify({ user: true }));

    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    await assert.rejects(
        () => parseChatGPTOfficialExportZip(buffer),
        /No conversations\.json or numbered conversations-\*\.json/
    );
});

test('ChatGPT official import - original unsafe entry names are rejected even if JSZip sanitizes them', async () => {
    const zip = installJSZip();
    zip.file('../conversations.json', JSON.stringify([
        { id: 'evil', mapping: {} }
    ]));

    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    await assert.rejects(
        () => parseChatGPTOfficialExportZip(buffer),
        /Unsafe ZIP entry path/
    );
});

test('ChatGPT official import - progress reports each conversation source without exposing conversation content', async () => {
    const zip = installJSZip();
    zip.file('conversations-000.json', JSON.stringify([{ id: 'a', mapping: {} }]));
    zip.file('conversations-001.json', JSON.stringify([{ id: 'b', mapping: {} }]));

    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const events: any[] = [];
    await parseChatGPTOfficialExportZip(buffer, event => events.push(event));

    assert.deepStrictEqual(events, [
        {
            phase: 'conversations',
            current: 1,
            total: 2,
            source: 'conversations-000.json'
        },
        {
            phase: 'conversations',
            current: 2,
            total: 2,
            source: 'conversations-001.json'
        }
    ]);
});
