import { fixtureAccount } from './helpers/domainFixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTakeoutResourceResolver, type TakeoutSourceFile } from '../src/l1/parsers/gemini/takeout/archiveResources.js';
import { parseGeminiTakeoutConversation } from '../src/l1/parsers/gemini/takeout/parseConversation.js';
import { parseGeminiTakeoutZipArchive } from '../src/l1/imports/takeout/readArchive.js';
import { assertDomainClosure } from '../src/l2/closure.js';

const directory = 'Takeout/My Activity/Gemini Apps';
const activityPath = `${directory}/MyActivity.html`;
const inventory = (...paths: string[]): Record<string, TakeoutSourceFile> => Object.fromEntries(paths.map(path => [path, {}]));
function resolvedPath(resolve: ReturnType<typeof createTakeoutResourceResolver>, ref: string): string {
    const result = resolve(ref);
    assert.equal(result.status, 'resolved');
    if (result.status !== 'resolved') throw new Error('Expected a resolved resource');
    return result.resource.path;
}
function activity(answer: string): string {
    return `<div class="outer-cell"><a href="https://gemini.google.com/app/c_archive_contract">Conversation</a><div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Prompted Draw<br>2026-09-02T12:00:00Z<br>${answer}</div>1 generated image</div>`;
}

test('relative activity paths outrank root paths and duplicate basenames', () => {
    const files = inventory(`${directory}/photo.png`, 'photo.png', 'Other/photo.png', `${directory}/images/detail.png`, 'Takeout/My Activity/shared.pdf');
    const resolve = createTakeoutResourceResolver(files, activityPath);
    assert.equal(resolvedPath(resolve, 'photo.png'), `${directory}/photo.png`);
    assert.equal(resolvedPath(resolve, './images/detail.png'), `${directory}/images/detail.png`);
    assert.equal(resolvedPath(resolve, '../shared.pdf'), 'Takeout/My Activity/shared.pdf');
    assert.equal(resolvedPath(resolve, 'Other/photo.png'), 'Other/photo.png');
    assert.equal(createTakeoutResourceResolver(inventory('One/photo.png', 'Two/photo.png'))('photo.png').status, 'ambiguous');
});

test('real Takeout filename mismatch shapes recover all eighteen resources uniquely', () => {
    // Metadata shapes observed in a local Takeout export; titles, dates and hashes replaced.
    // This is a sanitized resolver contract, not a provider payload or live import fixture.
    const pairs: Array<[string, string]> = [
        ...Array.from({ length: 10 }, (_, i): [string, string] => {
            const name = `image-${i.toString(16).padStart(16, '0')}`;
            return [`${name}.png`, name];
        }),
        ['audit-1111111111111111.py', 'audit-1111111111111111'],
        ['bridge-2222222222222222.py', 'bridge-2222222222222222'],
        ['batch-3333333333333333.py', 'batch-3333333333333333'],
        ['log-2026-01-01-4444444444444444.log', 'log-2026-01-01-4444444444444444.txt'],
        ['IMG_0001-5555555555555555.jpeg', 'IMG_0001-5555555555555555.jpg'],
        ['IMG_0002-6666666666666666.jpeg', 'IMG_0002-6666666666666666.jpg'],
        ['Analytics-2026-01-01-000000.ips.c-7777777777777777.synced', 'Analytics-2026-01-01-000000.ips.c-7777777777777777'],
        ['Weekly%20Ad%20|%20Example%20|%20Report-8888888888888888.pdf', 'Weekly Ad _ Example _ Report-8888888888888888.pdf']
    ];
    const resolve = createTakeoutResourceResolver(inventory(...pairs.map(([, name]) => `${directory}/${name}`)), activityPath);
    for (const [ref, name] of pairs) assert.equal(resolvedPath(resolve, ref), `${directory}/${name}`);
});

test('stem and normalization collisions are ambiguous regardless of inventory order', () => {
    const scenarios = [
        { ref: 'image-0123456789abcdef.png', paths: ['one/image-0123456789abcdef', 'two/image-0123456789abcdef.jpg'] },
        { ref: 'report.log', paths: ['one/report.txt', 'two/report.csv'] },
        { ref: 'note | title.pdf', paths: ['one/note _ title.pdf', 'two/note _ title.pdf'] },
        { ref: 'analytics.ips.c-0123456789abcdef.synced', paths: ['one/analytics.ips.c-0123456789abcdef', 'two/analytics.ips.c-0123456789abcdef'] },
        { ref: 'note | title.png', paths: ['one/note _ title.jpg', 'two/note _ title.gif'] }
    ];
    for (const { ref, paths } of scenarios) {
        for (const ordered of [paths, [...paths].reverse()]) {
            const result = createTakeoutResourceResolver(inventory(...ordered), activityPath)(ref);
            assert.equal(result.status, 'ambiguous');
            if (result.status === 'ambiguous') assert.equal(result.candidates.length, 2);
        }
    }
});

test('an ambiguous stronger tier cannot be bypassed by a unique weaker match', () => {
    const resolve = createTakeoutResourceResolver(inventory('one/photo.png', 'two/photo.png', 'photo.jpg'));
    assert.equal(resolve('photo.png').status, 'ambiguous');
});

test('fallback preserves complete hashes and does not infer unrelated suffixes or case changes', () => {
    const resolve = createTakeoutResourceResolver(inventory('image-1111111111111111.jpg', 'report.pdf', 'PHOTO.JPG', 'one/analytics.ips.c-1111111111111111'));
    for (const ref of ['image-2222222222222222.png', 'report-final.pdf', 'photo.jpg', 'analytics.ips.c-2222222222222222.synced']) assert.equal(resolve(ref).status, 'missing');
});

test('URI decoding applies only to source references and archive filenames remain literal', () => {
    const resolve = createTakeoutResourceResolver(inventory(`${directory}/space name.pdf`, `${directory}/literal%20name.pdf`), activityPath);
    assert.equal(resolvedPath(resolve, 'space%20name.pdf'), `${directory}/space name.pdf`);
    assert.equal(resolvedPath(resolve, 'literal%2520name.pdf'), `${directory}/literal%20name.pdf`);
    assert.equal(resolve('literal%20name.pdf').status, 'missing');
});

test('extensionless image resolution retains generation facts and a separate acquisition handle', () => {
    const path = `${directory}/image-0123456789abcdef`;
    const entry = { _data: { uncompressedSize: 3 }, async: async () => new Uint8Array([0xff, 0xd8, 0xff]) };
    const result = parseGeminiTakeoutConversation({ htmlText: activity('<p><img src="image-0123456789abcdef.png"></p>'), activityPath, archiveFiles: { [path]: entry } }, { account: fixtureAccount('gemini'), providerId: 'gemini' });
    const asset = result.conversation.detail.assets[0];
    assert.equal(result.conversation.detail.assets.length, 1);
    assert.equal(asset.kind, 'image');
    assert.equal(asset.name, 'image-0123456789abcdef');
    assert.equal(asset.sourceUri, path);
    assert.equal(Reflect.get(asset ?? {}, 'generated'), undefined);
    assert.equal(asset.generation?.imageOrdinal, 0);
    assert.deepEqual(result.archiveResources[asset.id], { path, entry });
    assert.deepEqual(result.conversation.detail.messages[1].attachmentIds, [asset.id]);
    assert.ok(result.diagnostics.some(d => d.code === 'TAKEOUT_RESOURCE_NAME_FALLBACK'));
    assert.ok(!result.diagnostics.some(d => /MISSING|AMBIGUOUS|UNRESOLVED/.test(d.code)));
    assertDomainClosure((JSON.parse(JSON.stringify(result.conversation))).detail);
});

test('ZIP batch parsing retains the Gemini Apps activity directory in multi-product archives', async () => {
    const JSZip = require('../lib/jszip.min.js') as { new(): { file(path: string, data: string): void; generateAsync(options: { type: string }): Promise<Uint8Array> }; loadAsync(bytes: unknown): Promise<unknown> };
    const zip = new JSZip();
    zip.file(activityPath, activity('<p><img src="photo.png"></p>'));
    zip.file(`${directory}/photo.png`, 'Gemini image bytes');
    zip.file('Takeout/My Activity/Other Product/MyActivity.html', 'other product activity');
    zip.file('Takeout/My Activity/Other Product/photo.png', 'Other image bytes');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const context = { account: fixtureAccount(), providerId: 'gemini' as const, readArchive: (bytes: Uint8Array | ArrayBuffer | Blob) => JSZip.loadAsync(bytes) };
    const batch = await parseGeminiTakeoutZipArchive(bytes, context);
    assert.equal(batch.length, 1, 'non-Gemini products must not become conversation imports');
    const [selected] = batch;
    const asset = selected.conversation.detail.assets[0];
    assert.equal(selected.archiveResources[asset.id].path, `${directory}/photo.png`);
    assert.equal(await selected.archiveResources[asset.id].entry.async!('text'), 'Gemini image bytes');
    assert.ok(!selected.diagnostics.some(d => d.code === 'TAKEOUT_AMBIGUOUS_RESOURCE'));
});
