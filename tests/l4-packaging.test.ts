import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExportPathPlanner, planExportPaths, buildExportFiles, buildResourceFiles, packageExportFiles } from '../src/l4/packaging/index.js';
import { v2Account, v2Conversation, v2Document } from './helpers/l4V2Fixtures.js';
import type { PreparedResources } from '../src/shared/resources/resourceResult.js';
import { __setZipConstructor } from '../src/l4/packaging/writers/zipWriter.js';
import { ZipWriter, isPrecompressedAsset } from '../src/l4/packaging/writers/zipWriter.js';
import { assertExportPath } from '../src/l4/packaging/exportPath.js';
import { renderDocumentMarkdown } from '../src/l4/format/markdown/renderMarkdown.js';
import { renderDocumentHtml } from '../src/l4/format/html/renderHtml.js';
const JSZip = require('../lib/jszip.min.js');
test('ZIP preserves supplementary Unicode across streaming chunk boundaries', async () => {
    __setZipConstructor(JSZip);
    const content = 'x'.repeat(16383) + '👤 你\n' + 'y'.repeat(16382) + '🤖 助手';
    const writer = new ZipWriter();
    writer.writeFile('long.md', content);
    const zip = await JSZip.loadAsync(await (await writer.generateBlob()).arrayBuffer());
    const bytes = await zip.file('long.md').async('uint8array');
    assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(bytes), content);
});
const prepared: PreparedResources = new Map([
    ['a', { ok: true, resourceId: 'a', value: { bytes: new Uint8Array([1, 2]), mediaType: 'image/png' } }],
    ['b', { ok: true, resourceId: 'b', value: { bytes: new Uint8Array([3]), mediaType: 'image/png' } }],
    ['failed', { ok: false, resourceId: 'failed', reason: 'missing', code: 'MISSING' }],
]);
test('linked document paths are reserved before bytes arrive and attachment ZIP preserves them', async () => {
    __setZipConstructor(JSZip);
    const c = conversation();
    const planner = createExportPathPlanner('markdown');
    const plan = planner(c, new Map(), new Set(), undefined, new Set(['a', 'b']));
    const bodyPlan = { ...plan, externalResourceIds: new Set<string>() };
    const [body] = buildExportFiles('markdown', bodyPlan, 'body', new Map());
    assert.equal(body.fileName, plan.fileName);
    const attachments = buildResourceFiles(plan, prepared);
    const [archive] = await packageExportFiles([attachments], 'browserDownload', 'attachments.zip');
    assert.equal(archive.fileName, 'attachments.zip');
    const zip = await JSZip.loadAsync(await (archive.content as Blob).arrayBuffer());
    for (const path of Object.values(plan.resources)) assert.ok(zip.file(path), path);
    assert.deepEqual(Object.values(plan.resources), ['assets/123456_Photo.png', 'assets/123456_photo_2.png']);
});
test('one nested attachment is still delivered as a root-level ZIP', async () => {
    __setZipConstructor(JSZip);
    const [archive] = await packageExportFiles([[{fileName:'files/report.md',mimeType:'text/markdown',content:'report'}]],
        'browserDownload', 'attachments.zip');
    assert.equal(archive.fileName, 'attachments.zip');
    const zip = await JSZip.loadAsync(await (archive.content as Blob).arrayBuffer());
    assert.equal(await zip.file('files/report.md').async('string'), 'report');
});
test('independent tasks cannot bind a new document to stale attachment paths from a previous task', () => {
    const c = conversation();
    const expected = new Set(['a']);
    const first = createExportPathPlanner('markdown','task-one')(c,new Map(),new Set(),undefined,expected);
    const second = createExportPathPlanner('markdown','task-two')(c,new Map(),new Set(),undefined,expected);
    assert.equal(first.fileName,second.fileName,'folder document names remain stable');
    assert.notEqual(first.resources.a,second.resources.a);
    assert.match(first.resources.a,/^assets\/task-one\//);
    assert.match(second.resources.a,/^assets\/task-two\//);
});
function conversation(title = 'Chat') {
    // Fake L2's frozen v2 ReadonlyDomain input, never invoke L2 validation.
    return v2Conversation(title, [
        { id: 'a', kind: 'image', name: 'Photo.png' }, { id: 'b', kind: 'image', name: 'photo.png' },
        { id: 'failed', kind: 'file', name: 'missing.bin' },
    ]);
}
test('Packaging reserves batch paths case-insensitively and keeps resource IDs local', () => {
    const first = conversation();
    const second = conversation('chat');
    second.index.key.accountId = '10000000-0000-4000-8000-000000000002';
    second.detail.key = { ...second.index.key };
    const plans = planExportPaths([{ conversation: first, prepared, fileIds: new Set<string>() }, { conversation: second, prepared, fileIds: new Set<string>() }], 'markdown');
    assert.deepEqual(plans.map(p => p.fileName), ['Chat_123456.md', 'chat_123456_2.md']);
    assert.deepEqual(Object.values(plans[0].resources), ['assets/123456_Photo.png', 'assets/123456_photo_2.png']);
    assert.deepEqual(Object.values(plans[1].resources), ['assets/123456_Photo_3.png', 'assets/123456_photo_4.png']);
    assert.equal(plans[0].resources.failed, undefined);
});
test('Incremental path planner preserves the exact batch namespace and bindings', () => {
    const first = conversation();
    const second = conversation('chat');
    const planNext = createExportPathPlanner('markdown');
    const sequential = [planNext(first, prepared, new Set<string>()), planNext(second, prepared, new Set<string>())];
    const batch = planExportPaths([{ conversation: first, prepared, fileIds: new Set<string>() }, { conversation: second, prepared, fileIds: new Set<string>() }], 'markdown');
    assert.deepEqual(sequential, batch);
    assert.equal(sequential[1].fileName, 'chat_123456_2.md');
    assert.equal(sequential[1].resources.a, 'assets/123456_Photo_3.png');
});
test('Packaging reserves long sanitized collision suffixes without writer truncation', () => {
    const c = conversation('z'.repeat(200));
    c.detail.assets[0].name = 'x'.repeat(68) + '.longextension';
    c.detail.assets[1].name = c.detail.assets[0].name;
    const plans = planExportPaths(Array.from({ length: 12 }, () => ({ conversation: c, prepared, fileIds: new Set<string>() })), 'html');
    const paths = plans.flatMap(p => [p.fileName, ...Object.values(p.resources)]);
    assert.equal(new Set(paths.map(p => p.toLowerCase())).size, paths.length);
    paths.forEach(assertExportPath);
});
test('Packaging sanitizes traversal, encoded separators and reserved filenames before binding', () => {
    const c = conversation();
    c.detail.assets[0].name = '../../%2e%2e%2fCON.png';
    const [plan] = planExportPaths([{ conversation: c, prepared, fileIds: new Set<string>() }], 'json');
    Object.values(plan.resources).forEach(assertExportPath);
    assert.ok(!plan.resources.a.includes('%'));
});
for (const format of ['markdown', 'html', 'json'] as const) {
    test(`${format}: each binding becomes an external file, with main first and unchanged bytes`, async () => {
        const [plan] = planExportPaths([{ conversation: conversation(), prepared, fileIds: new Set<string>() }], format);
        const files = buildExportFiles(format, plan, 'body', prepared);
        assert.deepEqual(files.map(f => f.fileName), [plan.fileName, ...Object.values(plan.resources)]);
        assert.deepEqual(Object.keys(files[0]).sort(), ['content', 'fileName', 'mimeType']);
        const resource = prepared.get('a')!;
        assert.ok(resource.ok);
        assert.equal(files[1].content, resource.value.bytes);
        __setZipConstructor(JSZip);
        const [artifact] = await packageExportFiles([files], 'browserDownload');
        const zip = await JSZip.loadAsync(await (artifact.content as Blob).arrayBuffer());
        for (const file of files) assert.ok(zip.file(file.fileName), file.fileName);
        assert.equal(zip.file(plan.fileName) !== null, true);
        assert.ok(!Object.keys(zip.files).some(path => path.startsWith('gemini_export/')));
    });
}
test('Packaging rejects dangling external bindings before Delivery; Image-only PDF emits only main', () => {
    const input = { conversation: conversation(), prepared, fileIds: new Set<string>() };
    const [markdownPlan] = planExportPaths([input], 'markdown');
    // A Markdown plan must export its successful bindings; losing a prepared
    // resource after path planning fails closed before Delivery.
    assert.throws(() => buildExportFiles('markdown', markdownPlan, 'body', new Map()), /Bound resource unavailable/);
    const [pdfPlan] = planExportPaths([input], 'pdf');
    assert.equal(pdfPlan.externalResourceIds.size, 0, 'PDF without AST File references embeds images only');
    assert.equal(buildExportFiles('pdf', pdfPlan, new Uint8Array([1]), prepared).length, 1);
});
test('DOCX files are already compressed for batch ZIP packaging', () => {
    assert.equal(isPrecompressedAsset('conversation.docx'), true);
});

test('ZIP decision uses actual flattened files and delivery, never format or batch count', async () => {
    __setZipConstructor(JSZip);
    const a = { fileName: 'a.pdf', mimeType: 'application/pdf', content: new Uint8Array([1]) };
    const b = { ...a, fileName: 'b.pdf' };
    assert.deepEqual(await packageExportFiles([[a]], 'browserDownload'), [a]);
    assert.deepEqual(await packageExportFiles([[a], [], [b]], 'folderWriter'), [a, b]);
    assert.deepEqual(await packageExportFiles([[a]], 'folderWriter'), [a]);
    assert.match((await packageExportFiles([[a], [b]], 'browserDownload'))[0].fileName, /^conversations_\d+\.zip$/);
    assert.deepEqual(await packageExportFiles([[]], 'browserDownload'), []);
    await assert.rejects(packageExportFiles([[a, a]], 'folderWriter'), /Duplicate/);
});
test('ZIP writer rejects unsafe paths rather than rewriting renderer bindings', () => {
    __setZipConstructor(JSZip);
    const writer = new ZipWriter();
    for (const path of ['', '/root', '../x', 'assets/%2e%2e/x', 'a\\b', 'CON', 'a//b', 'a/'.repeat(2), 'z'.repeat(90) + '.md']) {
        assert.throws(() => writer.writeFile(path, 'x'), /Unsafe|Noncanonical|Empty/);
    }
});
test('ZIP generation failures reject without producing a delivery artifact', async () => {
    __setZipConstructor(class { file() {} async generateAsync(): Promise<never> { throw new Error('zip failed'); } });
    await assert.rejects(packageExportFiles([[{ fileName: 'a.md', mimeType: 'text/markdown', content: 'body' }, { fileName: 'b.md', mimeType: 'text/markdown', content: 'second' }]], 'browserDownload'), /zip failed/);
});

test('Format references resolve to the same planned ZIP entries for Markdown and HTML', async () => {
    __setZipConstructor(JSZip);
    const c = conversation();
    // L3b is outside L4; pass a v2 AST fixture directly to real format backends.
    const document = v2Document([
        { type: 'image', resourceId: 'a', alt: 'Photo' },
        { type: 'image', resourceId: 'b', alt: 'Photo' },
    ], { title: c.index.title, id: c.index.key.conversationId });
    for (const format of ['markdown', 'html'] as const) {
        const [plan] = planExportPaths([{ conversation: c, prepared, fileIds: new Set<string>() }], format);
        const content = format === 'markdown' ? renderDocumentMarkdown(document, plan.resources)
            : renderDocumentHtml(document, plan.resources).html;
        const files = buildExportFiles(format, plan, content, prepared);
        const [packed] = await packageExportFiles([files], 'browserDownload');
        const zip = await JSZip.loadAsync(await (packed.content as Blob).arrayBuffer());
        for (const path of Object.values(plan.resources)) {
            const encoded = path.split('/').map(encodeURIComponent).join('/');
            assert.ok(content.includes(encoded), `${format} reference: ${path}`);
            assert.ok(zip.file(path), `${format} entry: ${path}`);
        }
    }
});

test('Packaging adds missing resource extensions and preserves existing ones', () => {
    const c = conversation();
    c.detail.assets = [
        { id: 'a', kind: 'image', name: 'Generated Image', mediaType: 'image/png' },
        { id: 'b', kind: 'image', name: 'Generated Image.png', mediaType: 'image/png' },
        { id: 'doc', kind: 'file', name: 'Notes', document: { contentMarkdown: '# Notes' } },
        { id: 'unnamed.id', kind: 'file' },
    ];
    const bytes = new Uint8Array([1]);
    // Application has filled the trusted Domain MIME fallback for a and b.
    const resources: PreparedResources = new Map(c.detail.assets.map(asset => [asset.id, {
        ok: true, resourceId: asset.id, value: { bytes, mediaType: asset.mediaType },
    }]));
    const [plan] = planExportPaths([{ conversation: c, prepared: resources, fileIds: new Set<string>() }], 'markdown');
    assert.deepEqual(Object.values(plan.resources), [
        'assets/123456_Generated Image.png', 'assets/123456_Generated Image_2.png',
        'files/123456_Notes.md', 'files/123456_unnamed.id.bin',
    ]);
    const files = buildExportFiles('markdown', plan, 'body', resources);
    assert.equal(files[1].mimeType, 'image/png');
    assert.equal(files[4].mimeType, 'application/octet-stream');
});

test('folder attachment paths are stable across tasks, formats and batch order, with account and provider scopes', () => {
    const c = conversation();
    const account = v2Account();
    const expected = new Set(['a', 'b']);
    const first = createExportPathPlanner('markdown')(c, new Map(), new Set(), undefined, expected, account);
    assert.deepEqual(Object.values(first.resources), [
        `assets/gemini/${account.id}/same123456/Photo.png`,
        `assets/gemini/${account.id}/same123456/photo_2.png`,
    ]);
    const next = createExportPathPlanner('html');
    next(v2Conversation('Other', c.detail.assets, { conversationId: 'other123456' }), new Map(), new Set(), undefined, expected, account);
    assert.deepEqual(next(c, new Map(), new Set(), undefined, expected, account).resources, first.resources);
    assert.deepEqual(next(c, new Map(), new Set(), undefined, expected, account).resources, first.resources);
    const secondAccount = v2Account('gemini', '10000000-0000-4000-8000-000000000002');
    const other = v2Conversation('Other account', c.detail.assets, { accountId: secondAccount.id });
    assert.notEqual(next(other, new Map(), new Set(), undefined, expected, secondAccount).resources.a, first.resources.a);
    assert.match(next(c, new Map(), new Set(), undefined, expected, v2Account('chatgpt')).resources.a, /^assets\/chatgpt\//);
});
