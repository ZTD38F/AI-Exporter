import test from 'node:test';
import assert from 'node:assert/strict';
import {
    decodeGeminiStructuredNode,
} from '../src/l1/parsers/gemini/rpc/structuredContent.js';

interface NodeAccessTracker {
    trackNode<T extends Record<string, unknown>>(id: string, obj: T): T;
    accessCounts: Map<string, number>;
}

function createNodeAccessTracker(): NodeAccessTracker {
    const accessCounts = new Map<string, number>();
    return {
        trackNode<T extends Record<string, unknown>>(id: string, obj: T): T {
            accessCounts.set(id, 0);
            return new Proxy(obj, {
                get(target, prop, receiver) {
                    if (prop === 'nodeType') {
                        accessCounts.set(id, (accessCounts.get(id) ?? 0) + 1);
                    }
                    return Reflect.get(target, prop, receiver);
                }
            });
        },
        accessCounts
    };
}

test('single-pass decode: access count per node in nested list is strictly linear O(1) per node', () => {
    const { trackNode, accessCounts } = createNodeAccessTracker();

    const depth = 6;
    const leaf = trackNode('node_leaf', {
        nodeType: 18,
        text: 'Leaf content'
    });

    let current: Record<string, unknown> = leaf;
    for (let d = depth - 1; d >= 0; d--) {
        const item = { children: [current] };
        current = trackNode(`node_list_${d}`, {
            nodeType: 20,
            items: [item]
        });
    }

    const decoded = decodeGeminiStructuredNode(current);
    assert.ok(decoded);

    // In the old implementation with redundant validation passes,
    // the leaf node was evaluated 2^depth times (2^6 = 64 times).
    // With single-pass decode, every node must be evaluated exactly ONCE.
    assert.strictEqual(accessCounts.get('node_leaf'), 1, 'Leaf nodeType must be accessed exactly once');
    for (let d = 0; d < depth; d++) {
        assert.strictEqual(accessCounts.get(`node_list_${d}`), 1, `List at depth ${d} must be accessed exactly once`);
    }
});

test('single-pass decode: access count per cell child in table is strictly linear', () => {
    const { trackNode, accessCounts } = createNodeAccessTracker();

    const cellText1 = trackNode('cell_1', { nodeType: 18, text: 'Cell 1' });
    const cellText2 = trackNode('cell_2', { nodeType: 18, text: 'Cell 2' });
    const tableNode = trackNode('table', {
        nodeType: 17,
        rows: [
            {
                cells: [
                    { children: [cellText1] },
                    { children: [cellText2] }
                ]
            }
        ]
    });

    const decoded = decodeGeminiStructuredNode(tableNode);
    assert.ok(decoded);
    assert.strictEqual(accessCounts.get('table'), 1);
    assert.strictEqual(accessCounts.get('cell_1'), 1, 'Cell 1 must be decoded exactly once');
    assert.strictEqual(accessCounts.get('cell_2'), 1, 'Cell 2 must be decoded exactly once');
});

test('single-pass decode: annotation access count in TextNode is strictly linear', () => {
    let annotationTypeAccessCount = 0;
    const annotationProxy = new Proxy({
        start: 0,
        end: 4,
        type: 0
    }, {
        get(target, prop, receiver) {
            if (prop === 'type') {
                annotationTypeAccessCount++;
            }
            return Reflect.get(target, prop, receiver);
        }
    });

    const textNode = {
        nodeType: 18,
        text: 'test',
        annotations: [annotationProxy]
    };

    const decoded = decodeGeminiStructuredNode(textNode);
    assert.ok(decoded);
    assert.strictEqual(annotationTypeAccessCount, 1, 'Annotation type must be inspected exactly once');
});

test('single-pass decode: mixed heterogeneous hierarchy (Table -> Cell -> Quote -> OrderedList -> Text) decodes each node once and preserves AST', () => {
    const { trackNode, accessCounts } = createNodeAccessTracker();

    const text = trackNode('hetero_text', { nodeType: 18, text: 'Deepest content' });
    const orderedList = trackNode('hetero_ordered_list', {
        nodeType: 14,
        VHa: 5,
        items: [{ children: [text] }]
    });
    const quote = trackNode('hetero_quote', { nodeType: 15, children: [orderedList] });
    const table = trackNode('hetero_table', {
        nodeType: 17,
        rows: [
            {
                cells: [
                    { children: [quote], colSpan: 2, rowSpan: 1 }
                ]
            }
        ]
    });

    const decoded = decodeGeminiStructuredNode(table);
    assert.ok(decoded);
    assert.strictEqual(accessCounts.get('hetero_table'), 1);
    assert.strictEqual(accessCounts.get('hetero_quote'), 1);
    assert.strictEqual(accessCounts.get('hetero_ordered_list'), 1);
    assert.strictEqual(accessCounts.get('hetero_text'), 1);

    // Verify AST structural integrity without type assertions
    if (decoded.nodeType === 17) {
        const firstRow = decoded.rows[0];
        const firstCell = firstRow?.cells[0];
        assert.strictEqual(firstCell?.colSpan, 2);
        assert.strictEqual(firstCell?.rowSpan, 1);
        const quoteChild = firstCell?.children[0];
        if (quoteChild?.nodeType === 15) {
            const listChild = quoteChild.children[0];
            if (listChild?.nodeType === 14) {
                assert.strictEqual(listChild.VHa, 5);
                const textChild = listChild.items[0]?.children[0];
                if (textChild?.nodeType === 18) {
                    assert.strictEqual(textChild.text, 'Deepest content');
                } else {
                    assert.fail('Expected TextNode child');
                }
            } else {
                assert.fail('Expected OrderedListNode child');
            }
        } else {
            assert.fail('Expected QuoteNode child');
        }
    } else {
        assert.fail('Expected TableNode root');
    }
});

test('deep nesting complexity: depth-20 list confirms linear single-pass node access without exponential explosion', () => {
    const { trackNode, accessCounts } = createNodeAccessTracker();

    let current: Record<string, unknown> = trackNode('deep_leaf', { nodeType: 18, text: 'Deepest' });
    for (let d = 0; d < 20; d++) {
        current = trackNode(`deep_list_${d}`, {
            nodeType: 20,
            items: [{ children: [current] }]
        });
    }

    const decoded = decodeGeminiStructuredNode(current);
    assert.ok(decoded);

    // In exponential 2^d recursion, 20 levels would yield over 1,000,000 evaluations.
    // In single-pass linear O(N) decoding, exactly 21 nodes are registered and each is accessed once.
    assert.strictEqual(accessCounts.size, 21, 'Total registered nodes must be 21');
    for (const [id, count] of accessCounts) {
        assert.strictEqual(count, 1, `Node ${id} must be evaluated exactly once`);
    }
});

test('fail-closed semantics: invalid children at any depth or malformed containers return null', () => {
    const invalidText = decodeGeminiStructuredNode({
        nodeType: 18,
        text: 'hello',
        annotations: [{ start: 0, end: 5, type: 'unknown_invalid_type_123' }]
    });
    assert.strictEqual(invalidText, null);

    const invalidList = decodeGeminiStructuredNode({
        nodeType: 20,
        items: [
            {
                children: [
                    { nodeType: 18, text: 'valid' },
                    { nodeType: 999 } // invalid node type
                ]
            }
        ]
    });
    assert.strictEqual(invalidList, null);

    const invalidTable = decodeGeminiStructuredNode({
        nodeType: 17,
        rows: [
            {
                cells: [
                    {
                        children: [
                            { nodeType: 999 }
                        ]
                    }
                ]
            }
        ]
    });
    assert.strictEqual(invalidTable, null);

    const invalidQuote = decodeGeminiStructuredNode({
        nodeType: 15,
        children: [{ nodeType: 999 }]
    });
    assert.strictEqual(invalidQuote, null);

    assert.strictEqual(decodeGeminiStructuredNode({ nodeType: 20, items: [null] }), null);
    assert.strictEqual(decodeGeminiStructuredNode({ nodeType: 20, items: [{}] }), null);
    assert.strictEqual(decodeGeminiStructuredNode({ nodeType: 20, items: [{ children: 'invalid' }] }), null);
    assert.strictEqual(decodeGeminiStructuredNode({ nodeType: 17, rows: [null] }), null);
    assert.strictEqual(decodeGeminiStructuredNode({ nodeType: 17, rows: [{}] }), null);
    assert.strictEqual(decodeGeminiStructuredNode({ nodeType: 17, rows: [{ cells: [null] }] }), null);
    assert.strictEqual(decodeGeminiStructuredNode({ nodeType: 17, rows: [{ cells: [{}] }] }), null);
    assert.strictEqual(decodeGeminiStructuredNode({ nodeType: 17, rows: [{ cells: 123 }] }), null);
    assert.strictEqual(decodeGeminiStructuredNode({ nodeType: 15, children: 123 }), null);
});

test('edge cases: empty containers preserve original structure', () => {
    const textNoAnnots = decodeGeminiStructuredNode({
        nodeType: 18,
        text: 'hello'
    });
    assert.deepStrictEqual(textNoAnnots, {
        nodeType: 18,
        text: 'hello'
    });

    const textEmptyAnnots = decodeGeminiStructuredNode({
        nodeType: 18,
        text: 'hello',
        annotations: []
    });
    assert.deepStrictEqual(textEmptyAnnots, {
        nodeType: 18,
        text: 'hello',
        annotations: []
    });

    const emptyList = decodeGeminiStructuredNode({
        nodeType: 20,
        items: []
    });
    assert.deepStrictEqual(emptyList, {
        nodeType: 20,
        items: []
    });

    const emptyTable = decodeGeminiStructuredNode({
        nodeType: 17,
        rows: []
    });
    assert.deepStrictEqual(emptyTable, {
        nodeType: 17,
        rows: []
    });

    const emptyQuote = decodeGeminiStructuredNode({
        nodeType: 15,
        children: []
    });
    assert.deepStrictEqual(emptyQuote, {
        nodeType: 15,
        children: []
    });
});
