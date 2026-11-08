import { fixtureAccount } from './helpers/domainFixture.js';
import { parseGeminiTakeoutZipArchive } from '../src/l1/imports/takeout/readArchive.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGeminiTakeoutArchive, parseGeminiTakeoutConversation, type GeminiTakeoutRaw } from '../src/l1/parsers/gemini/takeout/parseConversation.js';
import { decodeTakeoutHtml } from '../src/l1/parsers/gemini/takeout/decodeHtml.js';
import { assertDomainClosure } from '../src/l2/closure.js';
import { textOfBlocks } from './helpers/contentText.js';

const ID = 'CaseSensitive_99';
function activity(prompt = 'Question', answer = '<p><strong>Answer</strong></p>', date = '2026-09-02T12:00:00Z', id = ID, extra = ''): string {
    return `<div class="outer-cell"><a href="https://gemini.google.com/app/c_${id}">Conversation</a><div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Prompted ${prompt}<br>${date}<br>${answer}</div>${extra}</div>`;
}
const native = (data: GeminiTakeoutRaw, targetConvId?: string) => parseGeminiTakeoutConversation(data, { account: fixtureAccount('gemini'), providerId: 'gemini', targetConvId });
const text = textOfBlocks;

test('Takeout raw HTML constructs Domain without persisted records or fabricated message dates', () => {
    const { conversation } = native({ htmlText: activity() });
    assert.equal(native({ htmlText: activity() }).conversationId, ID);
    assert.equal('key' in conversation.index, false);
    assert.equal(conversation.index.title, 'Question');
    assert.equal(Reflect.get(conversation, 'provenance'), undefined);
    assert.deepEqual(conversation.detail.messages.map(m => m.role), ['user', 'assistant']);
    assert.equal(text(conversation.detail.messages[1].content), 'Answer');
    const timestamp = Date.parse('2026-09-02T12:00:00Z');
    assert.deepEqual(conversation.detail.messages.map(m => m.timestamp), [timestamp, timestamp]);
    assert.equal(conversation.index.createdAt, undefined);
    assert.equal(native({ htmlText: activity('Question', '<p>Answer</p>') }).sourceVersion, undefined);
    assert.equal(conversation.index.activityAt, timestamp);
    assert.equal(conversation.index.updatedAt, undefined);
    assert.equal(conversation.detail.savedAt, undefined);
    assert.equal('updatedAt' in conversation, false);
    for (const message of conversation.detail.messages) assert.equal(message.id, undefined);
    assertDomainClosure((conversation).detail);
});

test('missing Takeout dates remain absent and activity logs never claim complete coverage', () => {
    const { conversation } = native({ htmlText: activity('Question', '<p>Answer</p>', '') });
    assert.equal(Reflect.get(conversation, 'updatedAt'), undefined);
    assert.equal(conversation.index.createdAt, undefined);
    for (const message of conversation.detail.messages) assert.equal(message.timestamp, undefined);
    assert.equal(conversation.detail.quality.status, 'partial');
});

test('batch and selected parsing preserve separate conversation identities and source chronology', () => {
    const htmlText = activity('Newer', '<p>New answer</p>', '2026-09-03T12:00:00Z') + activity('Older') + activity('Other', '<p>Other answer</p>', '', 'other_chat_99');
    assert.throws(() => native({ htmlText }), /targetConvId/);
    const batch = parseGeminiTakeoutArchive({ htmlText }, { account: fixtureAccount('gemini'), providerId: 'gemini' });
    assert.equal(batch.length, 2);
    const selected = native({ htmlText }, `c_${ID}`);
    assert.deepEqual(selected.conversation, batch[0].conversation);
    assert.deepEqual(selected.conversation.detail.messages.map(m => text(m.content)), ['Older', 'Answer', 'Newer', 'New answer']);
    assert.equal(batch[1].conversationId, 'other_chat_99');
});

test('archive source paths and handles stay separate from export destinations', () => {
    const entry = { _data: { uncompressedSize: 123 }, async: async () => 'source bytes' };
    const raw = { htmlText: activity('Read <a href="docs/report%3F.pdf">report</a>'), archiveFiles: { 'docs/report?.pdf': entry } };
    const result = native(raw);
    const asset = result.conversation.detail.assets[0];
    assert.equal(asset.kind, 'file');
    assert.equal(asset.name, 'report?.pdf');
    assert.equal(asset.byteLength, 123);
    assert.equal(asset.sourceUri, 'docs/report?.pdf');
    assert.equal(result.archiveResources[asset.id].entry, entry);
    assert.equal(result.archiveResources[asset.id].path, 'docs/report?.pdf');
    assert.equal('resourceHints' in result, false);
    assert.deepEqual(result.conversation.detail.messages[0].attachmentIds, [asset.id]);
    for (const field of ['localName', 'archiveResources', 'diagnostics', 'async', 'chatTime', 'lastSeen']) assert.ok(!JSON.stringify(result.conversation).includes(`"${field}":`));
    assertDomainClosure((result.conversation).detail);
});

test('missing and ambiguous archive files remain explicit resources with diagnostics', () => {
    const result = native({ htmlText: activity('Read <a href="photo.png">image</a> and <a href="missing.pdf">file</a>'), archiveFiles: { 'one/photo.png': {}, 'two/photo.png': {} } });
    assert.equal(result.conversation.detail.assets.length, 2);
    assert.ok(result.diagnostics.some(d => d.code === 'TAKEOUT_AMBIGUOUS_RESOURCE'));
    assert.ok(result.diagnostics.some(d => d.code === 'TAKEOUT_MISSING_RESOURCE'));
    assert.deepEqual(result.archiveResources, {});
    for (const asset of result.conversation.detail.assets) assert.equal(Object.hasOwn(asset, 'failureReason'), false);
    assertDomainClosure((result.conversation).detail);
});

test('generation without content or files stays diagnostic without inventing an assistant message', () => {
    const result = native({ htmlText: activity('Draw', '', '', ID, '2 generated images'), archiveFiles: { 'watermarked_img_unrelated.png': {} } });
    assert.equal('generation' in (result.conversation.detail.messages[1] ?? {}), false);
    assert.equal(result.conversation.detail.assets.length, 0);
    assert.ok(result.diagnostics.some(d => d.code === 'TAKEOUT_GENERATED_MEDIA_UNRESOLVED'));
    const restored = JSON.parse(JSON.stringify(result.conversation));
    assert.ok(restored.detail.messages.every((m: object) => !('generation' in m)));
    assertDomainClosure((restored).detail);
});

test('explicit generated output references close body and attachment relationships over one source asset', () => {
    const result = native({ htmlText: activity('Draw', '<p>Output <img src="images/source.png"></p>', '', ID, '1 generated image'), archiveFiles: { 'images/source.png': {} } });
    const asset = result.conversation.detail.assets[0];
    assert.equal(result.conversation.detail.assets.length, 1);
    assert.equal(Reflect.get(asset ?? {}, 'generated'), undefined);
    assert.equal(asset.generation?.imageOrdinal, 0);
    assert.deepEqual(result.conversation.detail.messages[1].attachmentIds, [asset.id]);
    assert.equal('generation' in (result.conversation.detail.messages[1] ?? {}), false);
    assertDomainClosure((result.conversation).detail);
});

test('uncertain media ownership preserves the source resource without inventing a message relationship', () => {
    const result = native({ htmlText: activity('Question', '<p>Answer</p>', '', ID, '<img src="unbound.png">'), archiveFiles: { 'unbound.png': {} } });
    assert.equal(result.conversation.detail.assets.length, 1);
    for (const message of result.conversation.detail.messages) assert.deepEqual(message.attachmentIds ?? [], []);
    assert.ok(result.diagnostics.some(d => d.code === 'TAKEOUT_UNBOUND_RESOURCE'));
    assertDomainClosure((result.conversation).detail);
});

test('long report HTML becomes authored Content AST without synthetic document IDs or filenames', () => {
    const report = `<h1>Research report</h1><div><p>${'Evidence '.repeat(400)}</p></div><p>Tail evidence</p><table><tr><th>Item</th></tr><tr><td>Value</td></tr></table>`;
    const result = native({ htmlText: activity('Research', report, '') });
    assert.equal(result.conversation.detail.assets.length, 0);
    assert.ok(text(result.conversation.detail.messages[1].content).includes('Tail evidence'));
    assert.ok(result.conversation.detail.messages[1].content.some(block => block.type === 'heading'));
    assert.ok(result.conversation.detail.messages[1].content.some(block => block.type === 'table'));
    const before = JSON.stringify(result.conversation);
    assert.deepEqual(JSON.parse(before), result.conversation);
    assertDomainClosure(JSON.parse(before).detail);
    assert.equal(JSON.stringify(result.conversation), before);
});

test('Takeout extraction has no export naming and native parsing does not call compatibility constructors', () => {
    assert.equal(native({ htmlText: activity() }).conversation.detail.messages.length, 2);
    const source = readFileSync(join(__dirname, '../src/l1/parsers/gemini/takeout/parseConversation.ts'), 'utf8');
    assert.doesNotMatch(source, /parseTakeoutHtmlBlocks|correlateGeneratedImages|parseConversationRecord|Date\.now|sanitizeFileName|localName/);
    assert.equal(decodeTakeoutHtml(activity())[0].conversationIds[0], ID);
    assert.throws(() => native({ htmlText: 'unsupported format' }), /Unsupported Takeout/);
    assert.throws(() => parseGeminiTakeoutArchive({ htmlText: activity() }, { account: fixtureAccount('openai'), providerId: 'openai' }), /providerId gemini/);
});


test('raw ZIP bytes decode directly to batch Domain results with actual archive entries', async () => {
    const JSZip = require('../lib/jszip.min.js') as { new(): { file(path: string, data: string): void; generateAsync(options: { type: string }): Promise<Uint8Array> }; loadAsync(bytes: unknown): Promise<unknown> };
    const zip = new JSZip();
    zip.file('Takeout/Gemini/MyActivity.html', activity('Question', '<p>Output <img src="photo.png"></p>'));
    zip.file('Takeout/Gemini/photo.png', 'image source bytes');
    const data = await zip.generateAsync({ type: 'uint8array' });
    const batch = await parseGeminiTakeoutZipArchive(data, { account: fixtureAccount('gemini'), providerId: 'gemini', readArchive: bytes => JSZip.loadAsync(bytes) });
    assert.equal(batch.length, 1);
    const [result] = batch;
    assert.equal(result.conversationId, ID);
    assert.equal(result.conversation.detail.assets.length, 1);
    const handle = result.archiveResources[result.conversation.detail.assets[0].id];
    assert.equal(handle.path, 'Takeout/Gemini/photo.png');
    assert.equal(await handle.entry.async!('text'), 'image source bytes');
    assertDomainClosure((JSON.parse(JSON.stringify(result.conversation))).detail);

});

test('ZIP parsing rejects malformed inventories, unverifiable HTML sizes and ambiguous activity selection', async () => {
    const data = new Uint8Array([1]);
    await assert.rejects(parseGeminiTakeoutZipArchive(data, { providerId: 'gemini', readArchive: async () => ({}) }), /inventory/);
    await assert.rejects(parseGeminiTakeoutZipArchive(data, { providerId: 'gemini',
        readArchive: async () => ({ files: { 'MyActivity.html': { async: async () => activity() } } }) }), /size|大小/);
    await assert.rejects(parseGeminiTakeoutZipArchive(data, { providerId: 'gemini',
        readArchive: async () => ({ files: { 'a/MyActivity.html': { _data: { uncompressedSize: 0 } }, 'b/MyActivity.html': { _data: { uncompressedSize: 0 } } } }) }), /activityPath/);
});


test('response-only activity cannot fabricate a user prompt from its first content cell', () => {
    const htmlText = activity().replace('Prompted Question<br>', '');
    const { conversation } = native({ htmlText });
    assert.deepEqual(conversation.detail.messages.map(m => m.role), ['assistant']);
    assert.equal(text(conversation.detail.messages[0].content), 'Answer');
});


test('authored assets prefixes are source paths and cannot collapse different ZIP entries', () => {
    const result = native({ htmlText: activity('Question', '<p><img src="assets/photo.png"><img src="photo.png"></p>'), archiveFiles: { 'assets/photo.png': {}, 'photo.png': {} } });
    assert.equal(result.conversation.detail.assets.length, 2);
    assert.deepEqual(result.conversation.detail.assets.map(asset => asset.sourceUri).sort(), ['assets/photo.png', 'photo.png']);
    assert.equal(result.conversation.detail.messages[1].attachmentIds?.length, 2);
    assertDomainClosure((result.conversation).detail);
});

test('Takeout user prompts preserve literal Markdown symbols while model HTML remains formatted', () => {
    const { conversation } = native({ htmlText: activity('**literal** _not-italic_ $5', '<p><strong>Answer</strong></p>') });
    const [user, assistant] = conversation.detail.messages;
    assert.deepEqual(user.content, [{ type: 'paragraph', children: [{ type: 'text', text: '**literal** _not-italic_ $5' }] }]);
    assert.ok(assistant.content.some(block => block.type === 'paragraph' &&
        block.children.some(child => child.type === 'strong')), 'assistant formatting stays parsed');
});
