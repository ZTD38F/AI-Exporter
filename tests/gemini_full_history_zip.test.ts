import test from 'node:test';
import assert from 'node:assert/strict';
import { runExport } from '../src/application/export/runExport.js';
import { getExportRecord } from '../src/l3a/storageService.js';
import { __getZipConstructor, __setZipConstructor } from '../src/l4/packaging/writers/zipWriter.js';
import { v2ExportHost, exportRequest, seedExportConversation, exportKey } from './helpers/v2ExportHost.js';

const JSZip = require('../lib/jszip.min.js');

test('301 Gemini conversations physically survive one local ZIP delivery', async t => {
    const host = v2ExportHost(t);
    const old = __getZipConstructor();
    __setZipConstructor(JSZip);
    t.after(() => __setZipConstructor(old));
    const ids = Array.from({ length: 301 }, (_, i) => 'mass-' + String(i).padStart(4, '0'));
    for (const id of ids) await seedExportConversation(id);
    const result = await runExport(exportRequest(ids));
    assert.equal(result.exported, ids.length);
    assert.equal(result.partial, 0);
    assert.deepEqual(result.failed, []);
    assert.equal(host.clicks(), 1, 'all 301 conversations must be delivered once');
    assert.match(host.filenames[0], /\.zip$/);
    const archive = await JSZip.loadAsync(await host.blobs[0].arrayBuffer());
    const files = Object.values(archive.files) as Array<{ name: string; dir: boolean; async(type: string): Promise<string> }>;
    const markdown = files.filter(file => !file.dir && file.name.endsWith('.md'));
    assert.equal(markdown.length, ids.length, 'ZIP must contain 301 distinct Markdown files');
    const actual = new Set<string>();
    for (const entry of markdown) {
        const body = await entry.async('string');
        const match = /Answer for (mass-\d{4})/.exec(body);
        assert.ok(match, 'missing conversation response in ' + entry.name);
        assert.ok(!actual.has(match[1]), 'duplicate conversation in ZIP: ' + match[1]);
        actual.add(match[1]);
    }
    assert.deepEqual([...actual].sort(), ids);
    for (const id of ids) {
        assert.equal((await getExportRecord(exportKey(id)))?.status, 'ok', 'missing committed export record: ' + id);
    }
});
