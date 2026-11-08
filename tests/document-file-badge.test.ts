import test from 'node:test';
import assert from 'node:assert/strict';
import { fileBadge } from '../src/l4/format/shared/backendPresentation.js';
import { renderDocumentHtml } from '../src/l4/format/html/renderHtml.js';
import { renderDocumentTypst } from './helpers/renderTypstFixture.js';
import type { DocumentAst, DisplayBlock } from '../src/l3b/ast/ast.js';

test('file badge maps office/media types to short labels and safely falls back', () => {
    const cases = [
        ['application/pdf', 'PDF'], ['application/msword', 'DOC'],
        ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'DOCX'],
        ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'XLSX'],
        ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'PPTX'],
        [' APPLICATION/VND.OPENXMLFORMATS-OFFICEDOCUMENT.WORDPROCESSINGML.DOCUMENT ; charset=UTF-8', 'DOCX'],
        ['application/vnd.oasis.opendocument.text', 'ODT'], ['text/plain; charset=utf-8', 'TXT'],
        ['image/svg+xml', 'SVG'], ['application/x-zip-compressed', 'ZIP'],
        ['application/vnd.unknown-very-long-subtype', 'FILE'], ['__proto__/unknown', 'FILE'], ['application/octet-stream', 'FILE'],
    ];
    const blocks: Extract<DisplayBlock, { type: 'file' }>[] = cases.map(([mediaType]) => ({ type: 'file', resourceId: 'f', label: 'misleading.exe', kind: 'file', mediaType }));
    assert.deepEqual(blocks.map(fileBadge), cases.map(([, badge]) => badge));
    assert.equal(fileBadge({ ...blocks[0], kind: 'file', mediaType: undefined }), 'FILE');
    for (const [kind, expected] of [['image', 'IMAGE'], ['audio', 'AUDIO'], ['video', 'VIDEO'], ['other', 'FILE']] as const) {
        assert.equal(fileBadge({ ...blocks[0], kind, mediaType: 'application/unknown' }), expected);
    }
    assert.equal(fileBadge({ ...blocks[0], kind: 'other', mediaType: 'image/unknown' }), 'IMAGE');
    const document: DocumentAst = { title: 'Badges', metadata: { id: 'fixture', provider: 'test' }, messages: [{ role: 'assistant', blocks }] };
    const html = renderDocumentHtml(document, { f: 'assets/f' }).html;
    const pdf = renderDocumentTypst(document, {});
    assert.deepEqual([...html.matchAll(/gem-att-badge">([^<]+)</g)].map(match => match[1]), cases.map(([, badge]) => badge));
    assert.deepEqual(pdf.messages[0].blocks.map(block => block.type === 'file' && block.kind), cases.map(([, badge]) => badge));
});
