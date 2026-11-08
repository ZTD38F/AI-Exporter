import { fixtureAccount } from './helpers/domainFixture.js';
import { useIndexStorage } from './helpers/indexStorage.js';
useIndexStorage();
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGeminiTakeoutConversation } from '../src/l1/parsers/gemini/takeout/parseConversation.js';
import { importTakeout } from '../src/l1/imports/takeout/importTakeout.js';
import { createSourceResourceContext } from '../src/l1/resources/sourceResources.js';
import { getDetail } from '../src/l3a/storageService.js';
import { assertDomainClosure } from '../src/l2/closure.js';

const activity = (id: string, date: string, response: string) => `<div class="outer-cell"><a href="https://gemini.google.com/app/${id}">Chat</a>
<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Prompted Draw<br>2 generated images.<br>${date}<br>${response}</div></div>`;

test('Takeout generated ownership uses explicit response references despite closer unrelated events', () => {
    const htmlText = activity('owner_chat_001', '2026-09-02T12:00:00Z', '<img src="first.png"><img src="second.png">')
        + activity('closer_chat_002', '2026-09-02T12:00:01Z', '<p>No image references</p>');
    for (const names of [['first.png', 'second.png', 'unowned.png'], ['unowned.png', 'second.png', 'first.png']]) {
        const data = { htmlText, archiveFiles: Object.fromEntries(names.map(name => [name, { dir: false }])) };
        const { conversation } = parseGeminiTakeoutConversation(data, { account: fixtureAccount('gemini'), providerId: 'gemini', targetConvId: 'owner_chat_001' });
        assertDomainClosure((conversation).detail);
        const images = conversation.detail.messages[1].attachmentIds!.map(id => conversation.detail.assets.find(a => a.id === id)!);
        assert.deepEqual(images.map(a => a.name).sort(), ['first.png', 'second.png']);
        for (const image of images) assert.equal(image.generation?.imageOrdinal, undefined);
        const other = parseGeminiTakeoutConversation(data, { account: fixtureAccount('gemini'), providerId: 'gemini', targetConvId: 'closer_chat_002' });
        assert.equal(other.conversation.detail.assets.length, 0);
    }
});

test('Takeout response dates equal the source activity date without a synthetic offset', () => {
    const timestamp = Date.parse('2026-09-02T12:00:00Z');
    const { conversation } = parseGeminiTakeoutConversation({
        htmlText: activity('same-date', '2026-09-02T12:00:00Z', '<p>Answer</p>')
    }, { account: fixtureAccount('gemini'), providerId: 'gemini' });
    assert.deepEqual(conversation.detail.messages.map(m => m.timestamp), [timestamp, timestamp]);
});

test('Ambiguous ZIP media retains its original bytes without claiming either generation event', async () => {
    const JSZip = require('../lib/jszip.min.js') as new () => {
        file(name: string, data: string | Uint8Array): void;
        generateAsync(options: { type: 'uint8array' }): Promise<Uint8Array>;
    };
    const previousJSZip: unknown = Reflect.get(globalThis, 'JSZip');
    Reflect.set(globalThis, 'JSZip', JSZip);
    const accountId = '10000000-0000-4000-8000-000000000001';
    const resources = createSourceResourceContext();
    try {
        const zip = new JSZip();
        const chatId = 'abcd1234abcd1234';
        const html = [40, 44].map(second => `<div class="outer-cell"><div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Prompted draw a cat<br>1 generated image.<br>Sep 2, 2026, 11:36:${second} AM PDT<br></div>https://gemini.google.com/app/${chatId}</div>`).join('');
        const filename = 'watermarked_img_unresolved.png';
        const bytes = new TextEncoder().encode('c2pa date="20260902183642Z"');
        zip.file('Takeout/Gemini Apps/MyActivity.html', html);
        zip.file(filename, bytes);
        await importTakeout(await zip.generateAsync({ type: 'uint8array' }) as unknown as File, accountId, undefined, resources);
        const stored = await getDetail({ accountId, conversationId: chatId });
        assert.ok(stored); assert.ok(stored.messages.every(m => !m.attachmentIds?.length));
        await assert.rejects(resources.acquire({ accountId, conversationId: chatId }, { id: filename, kind: 'image' }), /locator/);
    } finally {
        resources.release();
        Reflect.set(globalThis, 'JSZip', previousJSZip);
    }
});
