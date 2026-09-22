export {};
const test = require('node:test');
const assert = require('node:assert');

const {
    analyzeChatGPTGraph,
    normalizeChatGPTConversation
} = require('../src/core/provider/chatgpt/graph.js');

function msg(id: string, role: string, text: any, time: number, contentType = 'text') {
    return {
        id,
        author: { role },
        create_time: time,
        content: {
            content_type: contentType,
            parts: Array.isArray(text) ? text : [text]
        },
        metadata: {}
    };
}

test('ChatGPT graph - linear active path normalizes without structural loss', () => {
    const raw = {
        id: 'conv-linear',
        title: 'Linear',
        create_time: 1700000000,
        update_time: 1700000030,
        current_node: 'n3',
        mapping: {
            root: { id: 'root', parent: null, children: ['n1'], message: null },
            n1: { id: 'n1', parent: 'root', children: ['n2'], message: msg('m1', 'user', 'hello', 1700000001) },
            n2: { id: 'n2', parent: 'n1', children: ['n3'], message: msg('m2', 'assistant', 'hi', 1700000002) },
            n3: { id: 'n3', parent: 'n2', children: [], message: msg('m3', 'user', 'thanks', 1700000003) }
        }
    };

    const normalized = normalizeChatGPTConversation(raw, undefined, 'chatgpt-workspace');

    assert.strictEqual(normalized.id, 'conv-linear');
    assert.strictEqual(normalized.scopeKey, 'chatgpt-workspace');
    assert.strictEqual(normalized.messages.length, 3);
    assert.deepStrictEqual(normalized.messages.map((m: any) => m.role), ['user', 'model', 'user']);
    assert.deepStrictEqual(normalized.graph.activePathNodeIds, ['root', 'n1', 'n2', 'n3']);
    assert.strictEqual(normalized.graph.activePathComplete, true);
    assert.strictEqual(normalized.graph.normalizationComplete, true);
    assert.strictEqual(normalized.integrity.complete, true);
    assert.strictEqual(normalized.raw, raw, 'raw provider graph remains authoritative and preserved');
});

test('ChatGPT graph - regeneration branch is preserved in branch index and not confused with active path', () => {
    const raw = {
        id: 'conv-branch',
        title: 'Branching',
        current_node: 'a2-new',
        mapping: {
            root: { id: 'root', parent: null, children: ['u1'], message: null },
            u1: { id: 'u1', parent: 'root', children: ['a2-old', 'a2-new'], message: msg('m-u1', 'user', 'question', 1) },
            'a2-old': { id: 'a2-old', parent: 'u1', children: [], message: msg('m-old', 'assistant', 'old answer', 2) },
            'a2-new': { id: 'a2-new', parent: 'u1', children: [], message: msg('m-new', 'assistant', 'new answer', 3) }
        }
    };

    const result = analyzeChatGPTGraph(raw);

    assert.deepStrictEqual(result.diagnostics.activePathNodeIds, ['root', 'u1', 'a2-new']);
    assert.deepStrictEqual(result.activeMessages.map((m: any) => m.content), ['question', 'new answer']);
    assert.deepStrictEqual(result.diagnostics.branchPointNodeIds, ['u1']);
    assert.deepStrictEqual(result.diagnostics.alternateMessageNodeIds, ['a2-old']);
    assert.ok(result.branchIndex.some((n: any) => n.nodeId === 'a2-old' && n.hasMessage));
    assert.strictEqual(result.diagnostics.normalizationComplete, true);
});

test('ChatGPT graph - missing current_node does not silently invent an active branch', () => {
    const raw = {
        id: 'conv-no-current',
        mapping: {
            a: { id: 'a', parent: null, children: ['b'], message: msg('m-a', 'user', 'one', 1) },
            b: { id: 'b', parent: 'a', children: [], message: msg('m-b', 'assistant', 'two', 2) }
        }
    };

    const normalized = normalizeChatGPTConversation(raw);

    assert.strictEqual(normalized.messages.length, 0, 'must not sort all nodes and pretend that is the selected branch');
    assert.strictEqual(normalized.graph.activePathComplete, false);
    assert.strictEqual(normalized.graph.activePathStopReason, 'missing_current_node');
    assert.deepStrictEqual(normalized.graph.alternateMessageNodeIds.sort(), ['a', 'b']);
    assert.strictEqual(normalized.integrity.complete, false);
    assert.ok(normalized.integrity.reasons.includes('active_path:missing_current_node'));
});

test('ChatGPT graph - parent cycle on active branch is explicit PARTIAL state', () => {
    const raw = {
        id: 'conv-cycle',
        current_node: 'b',
        mapping: {
            a: { id: 'a', parent: 'b', children: ['b'], message: msg('m-a', 'user', 'A', 1) },
            b: { id: 'b', parent: 'a', children: ['a'], message: msg('m-b', 'assistant', 'B', 2) }
        }
    };

    const normalized = normalizeChatGPTConversation(raw);

    assert.strictEqual(normalized.graph.activePathComplete, false);
    assert.strictEqual(normalized.graph.activePathStopReason, 'parent_cycle');
    assert.deepStrictEqual(normalized.graph.cycleNodeIds, ['a', 'b']);
    assert.strictEqual(normalized.integrity.complete, false);
    assert.ok(normalized.integrity.reasons.includes('graph_cycle'));
});

test('ChatGPT graph - orphan parents and dangling children are surfaced, not repaired silently', () => {
    const raw = {
        id: 'conv-drift',
        current_node: 'n1',
        mapping: {
            n1: {
                id: 'n1',
                parent: 'missing-parent',
                children: ['missing-child'],
                message: msg('m1', 'user', 'hello', 1)
            }
        }
    };

    const normalized = normalizeChatGPTConversation(raw);

    assert.deepStrictEqual(normalized.graph.orphanParentNodeIds, ['n1']);
    assert.deepStrictEqual(normalized.graph.danglingChildRefs, [
        { parentNodeId: 'n1', childNodeId: 'missing-child' }
    ]);
    assert.strictEqual(normalized.graph.activePathComplete, false);
    assert.strictEqual(normalized.graph.activePathStopReason, 'missing_parent');
    assert.strictEqual(normalized.integrity.complete, false);
});

test('ChatGPT graph - unknown content object keeps message identity and reports unparsed provider content', () => {
    const raw = {
        id: 'conv-unknown-content',
        current_node: 'tool',
        mapping: {
            tool: {
                id: 'tool',
                parent: null,
                children: [],
                message: {
                    id: 'm-tool',
                    author: { role: 'tool' },
                    create_time: 1,
                    content: {
                        content_type: 'future_widget_v99',
                        parts: [{ opaque_future_payload: { x: 1 } }]
                    },
                    metadata: {}
                }
            }
        }
    };

    const normalized = normalizeChatGPTConversation(raw);

    assert.strictEqual(normalized.messages.length, 1, 'message-bearing tool node must not disappear');
    assert.strictEqual(normalized.messages[0].providerRole, 'tool');
    assert.strictEqual(normalized.messages[0].role, 'system');
    assert.strictEqual(normalized.messages[0].contentType, 'future_widget_v99');
    assert.strictEqual(normalized.messages[0].content, '');
    assert.strictEqual(normalized.graph.observedContentTypes.future_widget_v99, 1);
    assert.strictEqual(normalized.graph.unparsedContentParts, 1);
    assert.strictEqual(normalized.graph.normalizationComplete, false);
    assert.ok(normalized.integrity.reasons.includes('unparsed_content'));
});

test('ChatGPT graph - image pointer and metadata file descriptors survive normalization', () => {
    const raw = {
        id: 'conv-assets',
        current_node: 'n1',
        mapping: {
            n1: {
                id: 'n1',
                parent: null,
                children: [],
                message: {
                    id: 'm1',
                    author: { role: 'user' },
                    create_time: 1700000000,
                    content: {
                        content_type: 'multimodal_text',
                        parts: [
                            'look',
                            {
                                content_type: 'image_asset_pointer',
                                asset_pointer: 'file-service://file-image-1'
                            }
                        ]
                    },
                    metadata: {
                        attachments: [{
                            id: 'file-doc-1',
                            name: 'notes.pdf',
                            mime_type: 'application/pdf'
                        }]
                    }
                }
            }
        }
    };

    const normalized = normalizeChatGPTConversation(raw);
    const attachments = normalized.messages[0].attachments;

    assert.strictEqual(normalized.messages[0].content, 'look');
    assert.strictEqual(attachments.length, 2);
    assert.strictEqual(attachments[0].type, 'image');
    assert.strictEqual(attachments[0].assetPointer, 'file-service://file-image-1');
    assert.strictEqual(attachments[1].type, 'file');
    assert.strictEqual(attachments[1].fileId, 'file-doc-1');
    assert.strictEqual(attachments[1].fileName, 'notes.pdf');
});
