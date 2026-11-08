import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeChatGPTDetail } from '../src/l1/parsers/chatgpt/decodeDetail.js';
import { parseChatGPTConversation } from '../src/l1/parsers/chatgpt/parseConversation.js';
import { detailGen } from './fixtures/providers/chatgptDetail.js';

const id = 'source-chatgpt-1';

test('ChatGPT Detail boundary preserves complete, partial, cyclic and empty source evidence', () => {
    const cases = [
        ['C_DETAIL_L1_SOURCE_01', 'complete'],
        ['C_DETAIL_L1_SOURCE_02', 'partial'],
        ['C_DETAIL_L1_SOURCE_03', 'partial'],
        ['C_DETAIL_L1_SOURCE_04', 'unknown'],
        ['C_DETAIL_L1_SOURCE_05', 'complete'],
    ] as const;
    for (const [key, quality] of cases) {
        const original = detailGen(key), before = structuredClone(original);
        const conversation = decodeChatGPTDetail(original, id);
        assert.deepEqual(original, before, 'Boundary must not mutate source evidence');
        assert.equal(conversation.id, id);
        const parsed = parseChatGPTConversation({ conversation, assetsByNode: new Map() });
        assert.equal(parsed.conversation.detail.quality.status, quality, key);
    }
});

test('ChatGPT Detail boundary binds both native IDs and never relabels foreign evidence', () => {
    const original = detailGen('C_DETAIL_L1_SOURCE_01');
    assert.equal(decodeChatGPTDetail({ ...original, id: undefined, conversation_id: id }, id).id, id);
    for (const bad of [
        { ...original, id: 'foreign' },
        { ...original, conversation_id: 'foreign' },
        { ...original, id: undefined, conversation_id: 'foreign' },
        { ...original, id: id, conversation_id: null },
    ]) {
        assert.throws(() => decodeChatGPTDetail(bad, id), /Detail identity mismatch/);
    }
});

test('ChatGPT Detail boundary rejects untrusted mapping and message structures before typed parsing', () => {
    const original = detailGen('C_DETAIL_L1_SOURCE_01');
    const message = original.mapping.answer.message;
    for (const bad of [
        {}, { ...original, mapping: null },
        { ...original, mapping: [] },
        { ...original, mapping: { answer: 'not a node' } },
        { ...original, mapping: { answer: { id: 'wrong', children: [] } } },
        { ...original, mapping: { answer: { id: 'answer', children: 'invalid' } } },
        { ...original, mapping: { answer: { id: 'answer', children: [], parent: 42 } } },
        { ...original, mapping: { answer: { id: 'answer', children: [], message: {} } } },
        { ...original, mapping: { answer: { id: 'answer', children: [], message: { ...message, author: null } } } },
        { ...original, mapping: { answer: { id: 'answer', children: [], message: { ...message, content: { content_type: 'text', parts: [null] } } } } },
        { ...original, mapping: { answer: { id: 'answer', children: [], message: { ...message, content: { content_type: 'multimodal_text', parts: [12] } } } } },
        { ...original, current_node: 22 },
    ]) {
        assert.throws(() => decodeChatGPTDetail(bad, id), TypeError);
    }
});

test('ChatGPT Detail decoder sanitizes optional nested metadata without leaking raw records', () => {
    const original = detailGen('C_DETAIL_L1_SOURCE_01');
    const answer = original.mapping.answer;
    const raw = {
        ...original,
        mapping: {
            ...original.mapping,
            answer: { ...answer, message: { ...answer.message, metadata: {
                model_slug: 'gpt-6',
                attachments: [{ id: 'f1', name: 'file.txt', mime_type: 'text/plain' }, { bad: 1 }],
                citations: [{ metadata: { title: 'Reference', url: 'https://example.com', fake: { nested: true } } }],
                content_references: [{ sources: [{ title: 'Second', url: 'https://second.example', fake: true }] }],
                aggregate_result: { messages: [{ message_type: 'image', image_url: 'https://img.example' }, null] },
                model_dil_v2: {
                    code: 'source', fallbackMarkdown: 'fallback',
                    constants: { good: 'resolved-id', bad: { untrusted: true } },
                    appData: { opGenui: { componentResults: {
                        r: { componentName: 'AsyncImage', status: 'resolved',
                            safe_urls: ['https://images.openai.com/valid', 1],
                            state: { images: [{ content_url: 'https://images.openai.com/valid' }] } },
                    } } },
                },
                strange: { shouldNotEscape: true },
            } } },
        },
    };
    const decoded = decodeChatGPTDetail(raw, id);
    const meta = decoded.mapping.get('answer')?.message?.metadata;
    assert.equal(meta?.model_slug, 'gpt-6');
    assert.deepEqual(meta?.attachments?.map(item => item.id), ['f1']);
    assert.deepEqual(meta?.citations, [{ metadata: { title: 'Reference', url: 'https://example.com' } }]);
    assert.deepEqual(meta?.content_references?.[0].sources, [{ title: 'Second', url: 'https://second.example' }]);
    assert.deepEqual(meta?.aggregate_result?.messages, [{ message_type: 'image', image_url: 'https://img.example' }]);
    assert.deepEqual(meta?.model_dil_v2?.constants, new Map([['good', 'resolved-id']]));
    assert.equal(meta?.model_dil_v2?.constants?.get('toString'), undefined);
    // A malformed safe_urls list must never be passed to the gallery selector.
    assert.deepEqual(meta?.model_dil_v2?.appData?.opGenui?.componentResults?.get('r')?.imageUrls, []);
    assert.equal('strange' in (meta ?? {}), false);
});

test('ChatGPT Detail boundary discards unused raw author.metadata without inventing an internal field', () => {
    const original = detailGen('C_DETAIL_L1_SOURCE_01');
    const answer = original.mapping.answer;
    const raw = {
        ...original,
        mapping: { ...original.mapping, answer: {
            ...answer, message: {
                ...answer.message, author: {
                    role: 'assistant', name: 'model', metadata: { untrusted: { data: 123 } },
                },
            },
        } },
    };
    const decoded = decodeChatGPTDetail(raw, id);
    assert.deepEqual(decoded.mapping.get('answer')?.message?.author, { role: 'assistant', name: 'model' });
    assert.equal('metadata' in (decoded.mapping.get('answer')?.message?.author ?? {}), false);
});

test('ChatGPT Detail boundary retains unknown content kinds as non-renderable, not guessed prose', () => {
    const original = detailGen('C_DETAIL_L1_SOURCE_01');
    const answer = original.mapping.answer;
    const decoded = decodeChatGPTDetail({
        ...original, mapping: {
            ...original.mapping,
            answer: { ...answer, message: { ...answer.message,
                content: { content_type: 'new_provider_kind', private_value: { body: 'not trustworthy' } } } },
        },
    }, id);
    assert.deepEqual(decoded.mapping.get('answer')?.message?.content, { content_type: 'new_provider_kind' });
});

test('ChatGPT Detail missing optional status does not invent incomplete branch coverage', () => {
    const original = detailGen('C_DETAIL_L1_SOURCE_01');
    const answer = original.mapping.answer;
    const withoutStatus = { ...original, mapping: {
        ...original.mapping, answer: {
            ...answer, message: { ...answer.message, status: undefined },
        },
    } };
    const conversation = decodeChatGPTDetail(withoutStatus, id);
    assert.equal(conversation.mapping.get('answer')?.message?.status, undefined);
    const parsed = parseChatGPTConversation({ conversation, assetsByNode: new Map() });
    assert.equal(parsed.conversation.detail.quality.status, 'complete');
});

test('ChatGPT manual and live Detail entrypoints both invoke the shared boundary', () => {
    const provider = readFileSync(join(__dirname, '../src/l1/client/chatgpt/chatgptProvider.ts'), 'utf8');
    const capture = readFileSync(join(__dirname, '../src/runtime/content/chatgptContent.ts'), 'utf8');
    assert.match(provider, /decodeChatGPTDetail\(raw, conversationId\)/);
    assert.match(capture, /decodeChatGPTDetail\(raw\.responseBody, key\.conversationId\)/);
    assert.doesNotMatch(provider, /as ChatGPTApiConversationWithId/);
    assert.doesNotMatch(capture, /as ChatGPTApiConversationWithId/);
});


test('ChatGPT gallery ingress approves locators once and preserves unresolved result identity', () => {
    const original = detailGen('C_DETAIL_L1_SOURCE_01');
    const answer = original.mapping.answer;
    const url = 'https://images.openai.com/approved';
    const rejected = ['http://images.openai.com/image', 'https://images.openai.com.evil.test/image',
        'https://evil.test/image', 'data:image/png;base64,AAAA', 'not a URL'];
    const source = {
        approved: { componentName: 'AsyncImage', status: 'resolved', safe_urls: [url],
            state: { images: [{ content_url: url }, { thumbnail_url: url },
                { content_url: '', thumbnail_url: url }, null, { content_url: 42, thumbnail_url: url }] } },
        unapproved: { componentName: 'AsyncImage', status: 'resolved', safe_urls: [],
            state: { images: [{ content_url: url }] } },
        invalid: { componentName: 'AsyncImage', status: 'resolved', safe_urls: rejected,
            state: { images: rejected.map(content_url => ({ content_url })) } },
        absent: { componentName: 'AsyncImage', status: 'pending' },
    };
    const before = structuredClone(source);
    const decoded = decodeChatGPTDetail({ ...original, mapping: { ...original.mapping,
        answer: { ...answer, message: { ...answer.message, metadata: {
            model_dil_v2: { appData: { opGenui: { componentResults: source } } },
        } } },
    } }, id);
    const results = decoded.mapping.get('answer')?.message?.metadata?.model_dil_v2?.appData?.opGenui?.componentResults;
    assert.deepEqual(results && Object.fromEntries(results), {
        approved: { componentName: 'AsyncImage', status: 'resolved', imageUrls: [url, url, url] },
        unapproved: { componentName: 'AsyncImage', status: 'resolved', imageUrls: [] },
        invalid: { componentName: 'AsyncImage', status: 'resolved', imageUrls: [] },
        absent: { componentName: 'AsyncImage', status: 'pending', imageUrls: [] },
    });
    assert.deepEqual(source, before, 'Ingress must not mutate source evidence');
});


test('ChatGPT Detail normalizes source times once before message and index assembly', () => {
    const original = detailGen('C_DETAIL_L1_SOURCE_01');
    const answer = original.mapping.answer;
    const cases = [
        [1700000000.1259, 1700000000125],
        [1700000000123.9, 1700000000123],
        ['2023-11-14T22:13:20Z', 1700000000000],
        // Already normalized pre-2001 milliseconds must not be treated as seconds again.
        ['1980-01-01T00:00:00Z', 315532800000],
        [1, 1000],
    ] as const;
    for (const [sourceTime, expected] of cases) {
        const raw = { ...original, create_time: sourceTime, update_time: sourceTime,
            mapping: { ...original.mapping, answer: { ...answer, message: { ...answer.message,
                create_time: sourceTime, update_time: sourceTime } } } };
        const before = structuredClone(raw);
        const decoded = decodeChatGPTDetail(raw, id);
        assert.equal(decoded.createdAtMs, expected);
        assert.equal(decoded.updatedAtMs, expected);
        assert.equal(decoded.mapping.get('answer')?.message?.createdAtMs, expected);
        assert.equal('updatedAtMs' in (decoded.mapping.get('answer')?.message ?? {}), false);
        assert.equal('create_time' in decoded, false);
        assert.equal('update_time' in decoded, false);
        const parsed = parseChatGPTConversation({ conversation: decoded, assetsByNode: new Map() });
        assert.equal(parsed.conversation.index.createdAt, expected);
        assert.equal(parsed.conversation.index.updatedAt, expected);
        assert.equal(parsed.sourceVersion, expected);
        assert.equal(parsed.conversation.detail.savedAt, expected);
        assert.equal(parsed.conversation.detail.messages.find(message => message.id === 'answer')?.timestamp, expected);
        assert.deepEqual(raw, before);
    }
});

test('ChatGPT Detail drops malformed optional times at ingress without fabricating dates', () => {
    const original = detailGen('C_DETAIL_L1_SOURCE_01');
    const answer = original.mapping.answer;
    for (const value of [undefined, null, 0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 2,
        '', 'invalid', {}, [], true]) {
        const decoded = decodeChatGPTDetail({ ...original, create_time: value, update_time: value,
            mapping: { ...original.mapping, answer: { ...answer, message: { ...answer.message,
                create_time: value, update_time: value } } } }, id);
        assert.equal('create_time' in decoded, false);
        assert.equal('update_time' in decoded, false);
        assert.equal('create_time' in (decoded.mapping.get('answer')?.message ?? {}), false);
        assert.equal('update_time' in (decoded.mapping.get('answer')?.message ?? {}), false);
        assert.equal(decoded.createdAtMs, undefined);
        assert.equal(decoded.updatedAtMs, undefined);
        assert.equal(decoded.mapping.get('answer')?.message?.createdAtMs, undefined);
        assert.equal('updatedAtMs' in (decoded.mapping.get('answer')?.message ?? {}), false);
        const parsed = parseChatGPTConversation({ conversation: decoded, assetsByNode: new Map() });
        assert.equal(parsed.sourceVersion, undefined);
        assert.equal(parsed.conversation.index.createdAt, undefined);
        assert.equal(parsed.conversation.index.updatedAt, undefined);
        assert.equal(parsed.conversation.detail.savedAt, undefined);
        assert.equal(parsed.conversation.detail.messages.find(message => message.id === 'answer')?.timestamp, undefined);
    }
});


test('ChatGPT node lookup never admits inherited object keys as source ancestors', () => {
    const original = detailGen('C_DETAIL_L1_SOURCE_01');
    for (const missingId of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
        for (const current_node of ['answer', missingId]) {
            const raw = { ...original, current_node, mapping: {
                answer: { ...original.mapping.answer, parent: missingId },
            } };
            const decoded = decodeChatGPTDetail(raw, id);
            const parsed = parseChatGPTConversation({ conversation: decoded, assetsByNode: new Map() });
            assert.equal(parsed.conversation.detail.quality.status, 'partial', missingId);
            assert.equal(decoded.mapping.get(missingId), undefined);
            assert.deepEqual(parsed.conversation.detail.messages.map(message => message.id),
                current_node === 'answer' ? ['answer'] : []);
        }
    }
});

test('ChatGPT decoder preserves own special node IDs without mutating the received mapping', () => {
    const original = detailGen('C_DETAIL_L1_SOURCE_01');
    for (const nodeId of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
        const raw = { ...original, current_node: nodeId, mapping: Object.fromEntries([
            ['root', { id: 'root', children: [nodeId] }],
            [nodeId, { ...original.mapping.answer, id: nodeId, parent: 'root' }],
        ]) };
        const before = structuredClone(raw);
        const decoded = decodeChatGPTDetail(raw, id);
        assert.equal(decoded.mapping.size, 2);
        assert.equal(decoded.mapping.get(nodeId)?.id, nodeId);
        const parsed = parseChatGPTConversation({ conversation: decoded, assetsByNode: new Map() });
        assert.equal(parsed.conversation.detail.quality.status, 'complete', nodeId);
        assert.deepEqual(parsed.conversation.detail.messages.map(message => message.id), [nodeId]);
        assert.deepEqual(raw, before);
    }
});
