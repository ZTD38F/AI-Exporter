import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertDomainClosure } from '../src/l2/closure.js';
import type { BlockNode } from '../src/l2/content/blocks.js';
import type { DomainConversationDetail } from '../src/l2/conversationDetail.js';

const citation = (citationId: string) => ({ type: 'citationRef' as const, citationId });
const paragraph = (citationId: string): BlockNode => ({
    type: 'paragraph',
    children: [{ type: 'strong', children: [{ type: 'emphasis', children: [{ type: 'strikethrough', children: [citation(citationId)] }] }] }],
});
const detail = (content: BlockNode[], reasoning?: BlockNode[]): Pick<DomainConversationDetail, 'assets' | 'messages' | 'quality'> => ({
    assets: [{ id: 'image', kind: 'image' }, { id: 'file', kind: 'file' }],
    quality: { status: 'complete' },
    messages: [{ role: 'assistant', citations: [{ id: 'source' }], content, ...(reasoning ? { reasoning } : {}) }],
});

test('typed citation closure traverses every legal inline/container position without mutation', () => {
    const blocks: BlockNode[] = [
        paragraph('source'),
        { type: 'heading', level: 2, children: [{ type: 'link', href: 'https://example.test', children: [citation('source')] }] },
        { type: 'list', ordered: false, items: [{ blocks: [{ type: 'quote', blocks: [paragraph('source')] }] }] },
        { type: 'table',
            caption: [citation('source')],
            headerRows: [{ cells: [{ children: [citation('source')] }] }],
            rows: [{ cells: [{ children: [citation('source')] }] }],
        },
        { type: 'image', assetId: 'image', caption: [citation('source')] },
        { type: 'file', assetId: 'file', description: [citation('source')] },
        { type: 'unknown', sourceType: 'future', text: 'preserve' },
    ];
    const conversation = detail(blocks, [{ type: 'quote', blocks: [paragraph('source')] }]);
    const snapshot = structuredClone(conversation);
    assert.doesNotThrow(() => assertDomainClosure(conversation));
    assert.deepEqual(conversation, snapshot);
});

test('typed citation closure rejects missing citations in every nested container', () => {
    const bad: BlockNode[] = [
        paragraph('missing'),
        { type: 'heading', level: 2, children: [citation('missing')] },
        { type: 'list', ordered: false, items: [{ blocks: [{ type: 'quote', blocks: [paragraph('missing')] }] }] },
        { type: 'table', caption: [citation('missing')], rows: [] },
        { type: 'table', headerRows: [{ cells: [{ children: [citation('missing')] }] }], rows: [] },
        { type: 'table', rows: [{ cells: [{ children: [citation('missing')] }] }] },
        { type: 'image', assetId: 'image', caption: [citation('missing')] },
        { type: 'file', assetId: 'file', description: [citation('missing')] },
    ];
    for (const [index, block] of bad.entries()) {
        assert.throws(() => assertDomainClosure(detail([block])), /Unregistered Domain citation/, `body case ${index}`);
        assert.throws(() => assertDomainClosure(detail([], [block])), /Unregistered Domain citation/, `reasoning case ${index}`);
    }
});

test('citation registries stay message-local with identical IDs', () => {
    const conversation = detail([paragraph('source')]);
    conversation.messages.push({ role: 'assistant', content: [paragraph('source')] });
    assert.throws(() => assertDomainClosure(conversation), /Unregistered Domain citation.*messages\[1\]/);
    conversation.messages[1].citations = [{ id: 'source' }];
    assert.doesNotThrow(() => assertDomainClosure(conversation));
});

test('asset closure rejects missing assets across all body and reasoning containers', () => {
    const image: BlockNode = { type: 'image', assetId: 'missing' };
    const paragraph: BlockNode = { type: 'paragraph', children: [{ type: 'link', href: 'https://example.test', children: [image] }] };
    const blocks: BlockNode[] = [
        image, { type: 'file', assetId: 'missing' }, paragraph,
        { type: 'heading', level: 1, children: [image] },
        { type: 'list', ordered: false, items: [{ blocks: [{ type: 'quote', blocks: [paragraph] }] }] },
        { type: 'table', caption: [image], rows: [] },
        { type: 'table', headerRows: [{ cells: [{ children: [image] }] }], rows: [] },
        { type: 'table', rows: [{ cells: [{ children: [image] }] }] },
        { type: 'image', assetId: 'image', caption: [image] },
        { type: 'file', assetId: 'file', description: [image] },
    ];
    for (const block of blocks) {
        assert.throws(() => assertDomainClosure(detail([block])), /Unregistered Domain asset 'missing'/);
        assert.throws(() => assertDomainClosure(detail([], [block])), /Unregistered Domain asset 'missing'/);
    }
});
