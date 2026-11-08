import test from 'node:test';
import assert from 'node:assert/strict';
import type { GeminiAttachmentNode, GeminiStructuredDocument } from '../src/l1/parsers/gemini/rpc/structuredContent.js';
import { extractResponseImageEvidence, type ImageAttachment } from '../src/l1/parsers/gemini/rpc/sourceAttachments.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type MediaContracts = [
    Assert<Equal<GeminiAttachmentNode['images'], ImageAttachment[] | undefined>>,
    Assert<Equal<Extract<keyof GeminiAttachmentNode, 'Xj'>, never>>,
    Assert<Equal<Parameters<typeof extractResponseImageEvidence>[3], GeminiStructuredDocument | undefined>>,
];
const contracts: MediaContracts = [true, true, true];
void contracts;

test('typed structured images survive nested containers without raw diagnostic evidence', () => {
    const generated: ImageAttachment = { sourceUrl: 'https://lh3.googleusercontent.com/decoded-generated', token: 'shared-token', isGenerated: true };
    const table: ImageAttachment = { sourceUrl: 'https://lh3.googleusercontent.com/decoded-table' };
    const ordered: ImageAttachment = { sourceUrl: 'https://lh3.googleusercontent.com/decoded-ordered' };
    const document: GeminiStructuredDocument = { children: [
        { nodeType: 'paragraph', children: [{ nodeType: 0, images: [generated, generated] }] },
        { nodeType: 15, children: [{ nodeType: 20, items: [{ children: [
            { nodeType: 17, rows: [{ cells: [{ children: [{ nodeType: 0, images: [table] }] }] }] },
        ] }] }] },
        { nodeType: 14, items: [{ children: [{ nodeType: 0, images: [ordered] }] }] },
    ] };
    const preview = ['https://lh3.googleusercontent.com/preview', 64, 64, 'shared-token'];
    const result = extractResponseImageEvidence([preview], [preview], '', document);
    assert.deepEqual(result.structuredImages, [generated, table, ordered]);
    assert.equal(result.structuredImages[0], generated, 'typed facts must be consumed directly, without reconstructing provider tuples');
    assert.deepEqual(result.images, [generated, table, ordered], 'generated preference, ordering and deduplication also apply across raw and decoded inputs');
});
