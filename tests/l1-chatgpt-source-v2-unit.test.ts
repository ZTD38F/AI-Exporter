import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChatGPTConversation } from '../src/l1/parsers/chatgpt/parseConversation.js';
import { parseChatGPTList } from '../src/l1/parsers/chatgpt/parseList.js';
import { listGen as chatgptListGen } from './fixtures/providers/chatgpt.js';
import { detailGen as chatgptDetailGen } from './fixtures/providers/chatgptDetail.js';
import { decodeChatGPTDetail } from '../src/l1/parsers/chatgpt/decodeDetail.js';
import { restoreDomainDetail } from '../src/l2/runtimeValidation.js';

const parse = (raw: { id: string }) => parseChatGPTConversation({
    conversation: decodeChatGPTDetail(raw, raw.id), assetsByNode: new Map(),
});

test('ChatGPT source branch to root yields keyless complete Detail and millisecond source times', () => {
    const raw = chatgptDetailGen('C_DETAIL_L1_SOURCE_01');
    const original = structuredClone(raw.mapping);
    const result = parse(raw);
    assert.equal(result.conversationId, 'source-chatgpt-1');
    assert.equal(result.conversation.detail.quality.status, 'complete');
    assert.equal(result.conversation.detail.savedAt, 1700000010000);
    assert.equal(result.conversation.index.updatedAt, 1700000010000);
    assert.equal(result.conversation.index.titleSource, 'provider');
    assert.equal('key' in result.conversation.index, false);
    assert.equal('key' in result.conversation.detail, false);
    assert.deepEqual(result.conversation.detail.messages.map(message => message.role), ['user', 'assistant']);
    assert.deepEqual(raw.mapping, original);
});

test('ChatGPT missing ancestors, cycles and unknown current node never fabricate full coverage', () => {
    const missing = parse(chatgptDetailGen('C_DETAIL_L1_SOURCE_02'));
    assert.equal(missing.conversation.detail.quality.status, 'partial');
    assert.ok(missing.diagnostics.some(d => d.code === 'CHATGPT_BRANCH_COVERAGE_INCOMPLETE'
        && d.details && typeof d.details === 'object' && !Array.isArray(d.details) && d.details.reason === 'ancestor_missing'));
    const cycle = parse(chatgptDetailGen('C_DETAIL_L1_SOURCE_03'));
    assert.equal(cycle.conversation.detail.quality.status, 'partial');
    assert.ok(cycle.diagnostics.some(d => d.details && typeof d.details === 'object' && !Array.isArray(d.details)
        && d.details.reason === 'ancestor_cycle'));
    const unknown = parse(chatgptDetailGen('C_DETAIL_L1_SOURCE_04'));
    assert.equal(unknown.conversation.detail.quality.status, 'unknown');
    assert.ok(unknown.diagnostics.some(d => d.details && typeof d.details === 'object' && !Array.isArray(d.details)
        && d.details.reason === 'current_node_missing'));
});

test('ChatGPT missing image bytes does not become missing body evidence', () => {
    const result = parse(chatgptDetailGen('C_DETAIL_L1_SOURCE_05'));
    assert.equal(result.conversation.detail.quality.status, 'complete');
    assert.equal(result.conversation.detail.assets.length, 1);
    assert.ok(result.diagnostics.some(d => d.code === 'CHATGPT_IMAGE_ASSET_DEFERRED' && d.severity === 'info'));
    assert.equal(result.conversation.detail.messages[0].attachmentIds, undefined);
    assert.deepEqual(result.conversation.detail.messages[0].content.filter(b => b.type === 'image').map(b => b.assetId), [result.conversation.detail.assets[0].id]);
});

test('ChatGPT Detail rejects empty attachment identities before exposing typed metadata', () => {
    const raw = chatgptDetailGen('C_DETAIL_L1_SOURCE_01');
    const message = raw.mapping.question?.message;
    assert.ok(message);
    message.metadata = { attachments: [
        { id: '', name: 'missing-id.txt', size: 12 },
        { id: 'missing-name', name: '', size: 13 },
        { id: 'notes', name: 'notes.txt', size: 14 },
        { id: 'picture', name: 'image.png', mime_type: 'image/png' },
    ] };
    const source = structuredClone(raw.mapping.question);
    const decoded = decodeChatGPTDetail(raw, raw.id);
    assert.deepEqual(decoded.mapping.get('question')?.message?.metadata?.attachments, [
        { id: 'notes', name: 'notes.txt', size: 14 },
        { id: 'picture', name: 'image.png', mime_type: 'image/png' },
    ]);
    const parsed = parseChatGPTConversation({ conversation: decoded, assetsByNode: new Map() });
    assert.equal(parsed.conversation.detail.quality.status, 'complete');
    assert.deepEqual(parsed.conversation.detail.assets.map(a => [a.id, a.name, a.byteLength]),
        [['file-notes', 'notes.txt', 14]]);
    assert.deepEqual(raw.mapping.question, source, 'the provider source must remain unchanged');
});

test('ChatGPT Detail only admits safe nonnegative attachment byte counts to L2', () => {
    for (const [size, expected] of [
        [-1, undefined], [1.5, undefined], [Number.MAX_SAFE_INTEGER + 1, undefined],
        [NaN, undefined], [Infinity, undefined], ['12', undefined], [null, undefined],
        [0, 0], [12, 12], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    ] as const) {
        const raw = chatgptDetailGen('C_DETAIL_L1_SOURCE_01');
        const message = raw.mapping.question?.message;
        assert.ok(message);
        message.metadata = { attachments: [{ id: 'file-size', name: 'data.bin' }] };
        const file = message.metadata.attachments?.[0];
        assert.ok(file);
        Object.assign(file, { size });

        const decoded = decodeChatGPTDetail(raw, raw.id);
        assert.equal(decoded.mapping.get('question')?.message?.metadata?.attachments?.[0]?.size, expected, String(size));
        const parsed = parseChatGPTConversation({ conversation: decoded, assetsByNode: new Map() });
        assert.equal(parsed.conversation.detail.assets.length, 1, String(size));
        assert.equal(parsed.conversation.detail.assets[0]?.byteLength, expected, String(size));
        assert.equal(parsed.conversation.detail.quality.status, 'complete', String(size));
        assert.doesNotThrow(() => restoreDomainDetail({ ...parsed.conversation.detail,
            key: { accountId: '00000000-0000-4000-8000-000000000001', conversationId: raw.id } }), String(size));
    }
});

test('ChatGPT Detail discards negative reasoning durations without losing valid fractional seconds', () => {
    for (const [duration, expected] of [
        [-1, undefined], [-0.25, undefined], [NaN, undefined], [Infinity, undefined],
        ['3', undefined], [0, 0], [1.25, 1.25],
    ] as const) {
        const raw = chatgptDetailGen('C_DETAIL_L1_SOURCE_01');
        const message = raw.mapping.answer?.message;
        assert.ok(message);
        message.metadata = { finished_duration_sec: 0 };
        Object.assign(message.metadata, { finished_duration_sec: duration });
        assert.equal(decodeChatGPTDetail(raw, raw.id).mapping.get('answer')?.message?.metadata?.finished_duration_sec,
            expected, String(duration));
    }
});

test('ChatGPT source-native paging fields remain evidence, not Domain Index fields', () => {
    const parsed = parseChatGPTList(chatgptListGen('C_L1_CHATGPT_SOURCE_V2_UNIT_01'));
    assert.equal(parsed.total, 1);
    assert.equal(parsed.offset, 0);
    assert.equal(parsed.limit, 100);
    assert.equal(parsed.hasMissingConversations, false);
    assert.deepEqual(parsed.conversations, [{ id: 'chat-1', title: 'Title', titleSource: 'provider',
        createdAt: 1700000000000, updatedAt: 1700000010000 }]);
    assert.equal('total' in parsed.conversations[0], false);
    assert.throws(() => parseChatGPTList(chatgptListGen('C_L1_CHATGPT_SOURCE_V2_UNIT_02')), TypeError);
});

test('ChatGPT optional legacy missing flag preserves absence and rejects malformed values', () => {
    const page = chatgptListGen('C_L1_CHATGPT_SOURCE_V2_UNIT_03');
    assert.equal(parseChatGPTList(page).hasMissingConversations, undefined);
    assert.equal(parseChatGPTList(chatgptListGen('C_L1_CHATGPT_SOURCE_V2_UNIT_04')).hasMissingConversations, true);
    for (const key of ['C_L1_CHATGPT_SOURCE_V2_UNIT_05_0', 'C_L1_CHATGPT_SOURCE_V2_UNIT_05_1', 'C_L1_CHATGPT_SOURCE_V2_UNIT_05_2', 'C_L1_CHATGPT_SOURCE_V2_UNIT_05_3'] as const) {
        const malformed = chatgptListGen(key);
        assert.throws(() => parseChatGPTList(malformed), TypeError);
    }
});

test('source termination evidence survives decoding and storage independently of snapshot coverage', () => {
    for (const variant of ['unfinished', 'interrupted', 'finished', 'tool', 'thoughts', 'handoff', 'unrecognized'] as const) {
        const raw = chatgptDetailGen('C_DETAIL_L1_SOURCE_01');
        const answer = raw.mapping.answer;
        assert.ok(answer?.message);
        const message = answer.message;
        message.end_turn = false;
        message.status = 'finished_successfully';
        if (variant === 'unfinished') {
            message.status = 'in_progress';
            message.content = { content_type: 'text', parts: ['## 本批完成：Migration / Released 1.7\n\n已'] };
        }
        if (variant === 'interrupted') message.metadata = { finish_details: { type: 'interrupted', reason: 'client_stopped' } };
        if (variant === 'finished') message.end_turn = true;
        if (variant === 'tool') message.recipient = 'api_tool.call_tool';
        if (variant === 'thoughts') message.content = { content_type: 'thoughts', thoughts: [] };
        if (variant === 'handoff') message.recipient = 'local.handoff';
        if (variant === 'unrecognized') message.status = 'unrecognized-status';
        const result = parse(raw);
        const expected = variant === 'tool' ? 'tool_pending' : variant === 'thoughts' ? 'unfinished'
            : variant === 'unrecognized' ? 'unknown' : variant;
        assert.deepEqual(result.conversation.detail.quality, {
            status: variant === 'handoff' ? 'partial' : 'complete', sourceTurn: expected,
        }, variant);
        if (variant === 'unfinished') assert.match(JSON.stringify(result.conversation.detail.messages), /Migration \/ Released 1.7/);
        const restored = restoreDomainDetail({ ...result.conversation.detail,
            key: { accountId: '00000000-0000-4000-8000-000000000001', conversationId: raw.id } });
        assert.equal(restored.quality.sourceTurn, expected);
        // Turn state cannot hide missing ancestors.
        answer.parent = 'missing';
        assert.equal(parse(raw).conversation.detail.quality.status, 'partial', variant);
    }
});

test('Work handoff exports visible card text without its internal prompt or raw JSON', () => {
    const raw = chatgptDetailGen('C_DETAIL_L1_SOURCE_01');
    const message = raw.mapping.answer?.message;
    assert.ok(message);
    const reason = '需要接着上一轮的测试审计进度，逐个读取真实测试和实现。';
    message.recipient = 'local.handoff';
    message.end_turn = false;
    message.content = { content_type: 'code', language: 'json', text: JSON.stringify({ reason, prompt: 'INTERNAL-PROMPT-DO-NOT-EXPORT' }) };
    const original = structuredClone(raw);
    const parsed = parse(raw);
    assert.deepEqual(parsed.conversation.detail.quality, { status: 'complete', sourceTurn: 'handoff' });
    assert.equal(parsed.conversation.detail.messages.length, 2);
    const body = JSON.stringify(parsed.conversation.detail.messages);
    assert.match(body, /Continue in ChatGPT Work/);
    assert.ok(body.includes(reason));
    assert.doesNotMatch(body, /INTERNAL-PROMPT|"prompt"|"language":"json"/);
    assert.deepEqual(raw, original, 'projection never mutates native source nodes');
    assert.ok(!parsed.diagnostics.some(d => d.code === 'CHATGPT_BRANCH_COVERAGE_INCOMPLETE'));
});

test('unreadable visible handoffs stay incomplete even when followed by a finished reply', () => {
    for (const text of ['{bad json', '{}', '{"reason":42}', '{"reason":"  "}', '{"prompt":"hidden-only"}']) {
        const raw = chatgptDetailGen('C_DETAIL_L1_SOURCE_01');
        const node = raw.mapping.answer;
        assert.ok(node?.message);
        node.message.recipient = 'local.handoff';
        node.message.content = { content_type: 'code', language: 'json', text };
        assert.equal(parse(raw).conversation.detail.quality.status, 'partial', text);
        const final = { ...node, id: 'final', parent: 'answer', message: { ...node.message,
            id: 'message-final', recipient: 'all', end_turn: true,
            content: { content_type: 'text', parts: ['Final reply'] } } };
        const followup = { ...raw, current_node: 'final', mapping: { ...raw.mapping, final } };
        assert.equal(parse(followup).conversation.detail.quality.status, 'partial', text);
    }
});

test('hidden handoff nodes do not invent visible cards or claim missing visible content', () => {
    const raw = chatgptDetailGen('C_DETAIL_L1_SOURCE_01');
    const message = raw.mapping.answer?.message;
    assert.ok(message);
    message.recipient = 'local.handoff';
    message.metadata = { is_visually_hidden_from_conversation: true };
    message.content = { content_type: 'code', language: 'json', text: '{"reason":"HIDDEN-REASON"}' };
    const parsed = parse(raw);
    assert.equal(parsed.conversation.detail.quality.status, 'complete');
    assert.doesNotMatch(JSON.stringify(parsed.conversation.detail.messages), /HIDDEN-REASON/);
});

test('source end state distinguishes hidden completion, user tails and tool steps without exposing hidden content', () => {
    for (const variant of ['hidden_finished', 'hidden_streaming', 'user_tail', 'tool_tail', 'missing_marker'] as const) {
        const raw = chatgptDetailGen('C_DETAIL_L1_SOURCE_01');
        const message = raw.mapping.answer?.message;
        assert.ok(message);
        message.status = 'finished_successfully';
        message.end_turn = true;
        if (variant.startsWith('hidden_')) {
            message.metadata = { is_visually_hidden_from_conversation: true };
            message.content = { content_type: 'text', parts: ['PRIVATE-HIDDEN-CONTENT'] };
            if (variant === 'hidden_streaming') { message.status = 'in_progress'; message.end_turn = false; }
        }
        if (variant === 'user_tail') message.author.role = 'user';
        if (variant === 'tool_tail') message.author.role = 'tool';
        if (variant === 'missing_marker') delete message.end_turn;
        const parsed = parse(raw);
        const expected = variant === 'hidden_finished' ? 'finished' : variant === 'hidden_streaming' ? 'unfinished'
            : variant === 'user_tail' ? 'awaiting_reply' : variant === 'tool_tail' ? 'tool_pending' : 'unknown';
        assert.deepEqual(parsed.conversation.detail.quality, { status: 'complete', sourceTurn: expected }, variant);
        const restored = restoreDomainDetail({ ...parsed.conversation.detail,
            key: { accountId: '00000000-0000-4000-8000-000000000001', conversationId: raw.id } });
        assert.equal(restored.quality.sourceTurn, expected);
        assert.doesNotMatch(JSON.stringify(parsed.conversation.detail.messages), /PRIVATE-HIDDEN-CONTENT/);
        const diagnostic = parsed.diagnostics.find(d => d.code === 'CHATGPT_SOURCE_TURN_STATUS');
        assert.ok(diagnostic?.details && typeof diagnostic.details === 'object' && !Array.isArray(diagnostic.details));
        assert.equal(diagnostic.details.leafRole, message.author.role);
        assert.equal(diagnostic.details.hidden, variant.startsWith('hidden_'));
        // A known termination state must never conceal an incomplete source chain.
        const answer = raw.mapping.answer;
        assert.ok(answer);
        answer.parent = 'missing';
        assert.equal(parse(raw).conversation.detail.quality.status, 'partial');
    }
});
