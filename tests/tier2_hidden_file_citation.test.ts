import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceDetail, sourceMessage } from './helpers/l1SourceFixture.js';
import { v2ExportHost, exportKey, exportRequest } from './helpers/v2ExportHost.js';
import { ingestDetail } from '../src/l2/ingestion.js';
import { runExport } from '../src/application/export/runExport.js';

for (const fallback of [false, true]) test(`Tier 2 uploaded-file chip ${fallback ? 'with Markdown fallback' : 'with native body'} does not add [1]; literals survive in physical Markdown`, async t => {
    const host = v2ExportHost(t);
    const parsed = sourceDetail({ id: 'hidden-file-chip', messages: [{ ...sourceMessage('answer'),
        content: 'Loaded input.txt[cite: 1]. Literal [1] and `[cite: 1]` remain.',
        groundingCitationMarkers: ['[cite: 1]'],
        structuredContent: { children: [{ nodeType: 'paragraph', children: [
            { nodeType: 18, text: 'Loaded input.txt' },
            { nodeType: 'citation', number: 1, title: 'input.txt' },
            { nodeType: 18, text: '. Literal [1] and ' },
            { nodeType: 18, text: '[cite: 1]', annotations: [{ start: 0, end: 9, type: 7 }] },
            { nodeType: 18, text: ' remain.' },
        ] }, ...(fallback ? [{ nodeType: 18 as const, text: 'unsupported', annotations: [{ start: 0, end: 11, type: 99 }] }] : [])] },
    }] });
    assert.equal(parsed.diagnostics.some(d => d.code === 'GEMINI_STRUCTURED_FALLBACK'), fallback);
    const { index, detail } = parsed.conversation;
    await ingestDetail(exportKey('hidden-file-chip').accountId, 'hidden-file-chip', detail, index);
    assert.equal((await runExport(exportRequest(['hidden-file-chip']))).exported, 1);
    const markdown = await host.blobs[0].text();
    assert.ok(markdown.includes('Loaded input.txt. Literal \\[1\\] and `[cite: 1]` remain.'), markdown);
    assert.equal(markdown.includes('input.txt[1]'), false);
});
