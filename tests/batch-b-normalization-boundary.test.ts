import { historicalFixture } from './helpers/nativeFixture.js';
import { prepareReadingResourcesFixture } from './helpers/pdfAcquisitionFixture.js';
import { resourceValue } from './helpers/resources.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationRecordInput } from './helpers/recordFixture/conversationRecord.js';

const imageBytes = Uint8Array.of(137, 80, 78, 71, 1, 2, 3);

for (const layout of ['messages', 'turns'] as const) {
    test(`V2 ${layout}: historical unknown content, role and image survive Domain -> AST -> shared acquisition`, async () => {
        const message = {
            role: 'historical-tool',
            content: { historical: ['payload', 42] },
            images: [{ url: 'https://example.com/generated' }],
        };
        const raw = {
            id: 'boundary-regression',
            ...(layout === 'messages' ? { messages: [message] } : { turns: [{ messages: [message] }] }),
        };
        const snapshot = structuredClone(raw);
        // Historical grammar is a test boundary. From here on we use only trusted v2 Domain.
        const parsed = historicalFixture(raw);
        const domainBefore = structuredClone(parsed.conversation);
        const fetched: string[] = [];
        const result = await prepareReadingResourcesFixture(parsed.conversation, {
            acquire: async asset => {
                fetched.push(asset.id);
                return { bytes: imageBytes, mediaType: 'image/png' };
            },
        });

        assert.equal(result.document.messages.length, 1);
        const node = result.document.messages[0];
        assert.equal(node.role, 'unknown');
        const unknownBlock = node.blocks.find(block => block.type === 'unsupported');
        assert.ok(unknownBlock && unknownBlock.type === 'unsupported');
        assert.match(unknownBlock.text, /historical.*payload.*42/);

        const [imageId] = [...result.references.imageIds];
        assert.ok(imageId, 'the historical image remains a referenced v2 Image');
        assert.deepEqual([...result.references.referencedIds], [imageId]);
        assert.deepEqual(fetched, [imageId], 'Application acquires only the referenced Asset ID');
        assert.equal(result.resources.size, 1);
        assert.deepEqual(resourceValue(result.resources.get(imageId)).bytes, imageBytes);

        // An explicit no-assets export keeps the reading AST and skips all bytes.
        const withoutAssets = await prepareReadingResourcesFixture(parsed.conversation, {
            includeAssets: false,
            acquire: async () => { assert.fail('includeAssets=false must not fetch'); },
        });
        assert.equal(withoutAssets.resources.size, 0);
        assert.deepEqual(withoutAssets.document, result.document);
        assert.deepEqual([...withoutAssets.references.imageIds], [imageId]);

        assert.ok(parsed.diagnostics.some(d => d.code === 'UNKNOWN_MESSAGE_CONTENT'));
        assert.ok(parsed.diagnostics.some(d => d.code === 'UNKNOWN_ROLE'));
        assert.deepEqual(parsed.conversation, domainBefore, 'preparing resources cannot mutate L2 facts');
        assert.deepEqual(raw, snapshot, 'historical source input remains immutable');
    });
}

test('parser accepts missing metadata and historical aliases without coercing raw evidence', () => {
    const raw: ConversationRecordInput = {
        messages: [{ role: 'tool', content: 17, images: [{ src: 'https://example.com/generated', fileName: 'historical' }] }],
    };
    const snapshot = structuredClone(raw);
    const { conversation: domain, diagnostics } = historicalFixture(raw, { providerId: 'gemini' });
    assert.equal(domain.detail.assets[0].kind, 'image');
    assert.equal(domain.detail.assets[0].name, 'historical');
    assert.equal(Object.hasOwn(domain.detail.messages[0], 'provenance'), false);
    assert.ok(diagnostics.some(d => d.code === 'UNKNOWN_MESSAGE_CONTENT'));
    assert.deepEqual(raw, snapshot);
});
