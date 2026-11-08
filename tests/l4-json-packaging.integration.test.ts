/**
 * Cross-module evidence retained from Packaging's former mixed unit scenario:
 * actual v2 L2 trust boundary + L4 JSON archive + L4 ZIP.
 * Not part of the isolated L4 unit gate, which stubs L2 services.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restoreDomainSnapshot } from '../src/l2/runtimeValidation.js';
import { fixtureAccountFor, fixtureKey } from './helpers/domainFixture.js';
import { planExportPaths, buildExportFiles, packageExportFiles } from '../src/l4/packaging/index.js';
import { serializeDomainJson } from '../src/l4/format/json/serializeDomainJson.js';
import { __setZipConstructor } from '../src/l4/packaging/writers/zipWriter.js';
import type { PreparedResources } from '../src/shared/resources/resourceResult.js';
const JSZip = require('../lib/jszip.min.js');

test('v2 L2 trusted Domain -> L4 JSON references -> same planned ZIP entries', async () => {
    const key = fixtureKey('same123456', 'gemini');
    const conversation = restoreDomainSnapshot({
        index: { key, title: 'Chat', titleSource: 'derived' },
        detail: { key, quality: { status: 'complete' }, messages: [
            { role: 'assistant', content: [{ type: 'image', assetId: 'a' }, { type: 'image', assetId: 'b' }] },
        ], assets: [
            { id: 'a', kind: 'image', name: 'Photo.png' },
            { id: 'b', kind: 'image', name: 'photo.png' },
        ] },
    });
    const prepared: PreparedResources = new Map([
        ['a', { ok: true, resourceId: 'a', value: { bytes: new Uint8Array([1, 2]), mediaType: 'image/png' } }],
        ['b', { ok: true, resourceId: 'b', value: { bytes: new Uint8Array([3]), mediaType: 'image/png' } }],
    ]);
    const [plan] = planExportPaths([{ conversation, prepared, fileIds: new Set<string>() }], 'json');
    const content = serializeDomainJson(conversation, fixtureAccountFor(conversation), plan.resources);
    const files = buildExportFiles('json', plan, content, prepared);
    __setZipConstructor(JSZip);
    const [packed] = await packageExportFiles([files], 'browserDownload');
    const zip = await JSZip.loadAsync(await (packed.content as Blob).arrayBuffer());
    for (const path of Object.values(plan.resources)) {
        assert.ok(content.includes(path), 'JSON reference: ' + path);
        assert.ok(zip.file(path), 'ZIP entry: ' + path);
    }
});
