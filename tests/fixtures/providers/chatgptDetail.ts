import { describeFixtures, synthetic } from './provenance.js';
import type { ChatGPTConversationNode } from '../../../src/l1/parsers/chatgpt/chatgptTypes.js';

/** Native JSON returned by GET /backend-api/conversation/:id (one payload per key). */
function textNode(id: string, parent: string, role: 'assistant' | 'user', content: string): ChatGPTConversationNode {
    return {
        id, parent, children: [],
        message: {
            id: 'message-' + id, author: { role }, recipient: 'all',
            status: 'finished_successfully', weight: 1, content: { content_type: 'text', parts: [content] },
        },
    };
}

function nativeDetail(mapping: Record<string, ChatGPTConversationNode>, current_node = 'answer') {
    return {
        id: 'source-chatgpt-1', title: 'Authored title', create_time: 1700000000,
        update_time: 1700000010, current_node, mapping, is_archived: false,
    };
}

function imageAcquisitionDetail() {
    const mapping: Record<string, ChatGPTConversationNode> = {
        root: { id: 'root', children: ['u1'] },
        u1: {
            id: 'u1', parent: 'root', children: ['t1'],
            message: {
                author: { role: 'user' },
                content: {
                    content_type: 'multimodal_text',
                    parts: [
                        'before image',
                        { content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_cat' },
                        'after image',
                    ],
                },
                id: 'msg-u1', recipient: 'all', status: 'finished_successfully', weight: 1,
            },
        },
        t1: {
            id: 't1', parent: 'u1', children: ['a1'],
            message: {
                author: { role: 'tool' },
                content: {
                    content_type: 'multimodal_text',
                    parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_missing' }],
                },
                id: 'msg-t1', recipient: 'all', status: 'finished_successfully', weight: 1,
            },
        },
        a1: {
            id: 'a1', parent: 't1', children: [],
            message: {
                author: { role: 'assistant' },
                content: { content_type: 'text', parts: ['here is your cat'] },
                id: 'msg-a1', recipient: 'all', status: 'finished_successfully', weight: 1,
            },
        },
    };
    return {
        title: 'img chat', create_time: 1700000000, update_time: 1700000060,
        current_node: 'a1', mapping, is_archived: false,
    };
}

const fixtureMap = {
    'C_CAPTURE_EMPTY_DETAIL_01': () => ({
        id: '6acffdc5-c4d0-83e8-8e1b-ba60979a618a', mapping: {},
    }),
    'C_PROVIDER_CHATGPT_TREE_IMAGE_DETAIL_01': () => imageAcquisitionDetail(),
    'C_PROVIDER_CHATGPT_TREE_INVALID_DETAIL_01': () => ({
        conversation_id: 'foreign', mapping: {},
    }),
    'C_PROVIDER_CHATGPT_TREE_INVALID_DETAIL_02': () => ({
        id: 'requested-conversation', mapping: null,
    }),
    'C_PROVIDER_CHATGPT_TREE_INVALID_DETAIL_03': () => ({
        id: 'requested-conversation', mapping: {
            one: { id: 'one', children: [], message: { bad: true } },
        },
    }),
    'C_PROVIDER_CHATGPT_TREE_FOREIGN_DETAIL_01': () => ({ id: 'other-conversation' }),
    'C_DETAIL_L1_SOURCE_01': () => nativeDetail({
        root: { id: 'root', children: ['question'] },
        question: textNode('question', 'root', 'user', 'Question'),
        answer: textNode('answer', 'question', 'assistant', 'Answer'),
    }),
    'C_DETAIL_L1_SOURCE_02': () => nativeDetail({
        answer: textNode('answer', 'missing', 'assistant', 'Answer'),
    }),
    'C_DETAIL_L1_SOURCE_03': () => nativeDetail({
        answer: textNode('answer', 'question', 'assistant', 'Answer'),
        question: textNode('question', 'answer', 'user', 'Question'),
    }),
    'C_DETAIL_L1_SOURCE_04': () => nativeDetail({}, ''),
    'C_DETAIL_L1_SOURCE_05': () => nativeDetail({
        root: { id: 'root', children: ['answer'] },
        answer: {
            id: 'answer', parent: 'root', children: [],
            message: {
                id: 'message-image', author: { role: 'assistant' },
                recipient: 'all', status: 'finished_successfully', weight: 1,
                content: {
                    content_type: 'multimodal_text',
                    parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://photo-1' }],
                },
            },
        },
    }),
};

export function detailGen<K extends keyof typeof fixtureMap>(key: K): ReturnType<(typeof fixtureMap)[K]> {
    return fixtureMap[key]() as ReturnType<(typeof fixtureMap)[K]>;
}

export const fixtureOrigins = describeFixtures(fixtureMap, synthetic("Authored ChatGPT protocol, content or state counterexample; no saved capture is used."));
