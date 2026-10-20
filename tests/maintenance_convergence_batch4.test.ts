// tests/maintenance_convergence_batch4.test.ts
// Tests for Batch 4: Maintenance Convergence
// (Unified deletion classifier, pagination completion contract, JSPB schema constants, URL scheme validation)
export {};
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// =========================================================================
// 1. Canonical Deletion & Detail Error Classifier
// =========================================================================
test('Batch 4 - Canonical classifyDetailError and isConfirmedDeletedError in GeminiProtocol', () => {
    const {
        isConfirmedDeletedError,
        classifyDetailError
    } = require('../src/core/protocol/protocol.js');

    // Confirmed deleted cases
    assert.strictEqual(isConfirmedDeletedError('["BardErrorInfo", 1167]'), true);
    assert.strictEqual(classifyDetailError('["BardErrorInfo", 1167]'), 'confirmed_deleted');
    assert.strictEqual(isConfirmedDeletedError('会话已在服务端删除 (c_123) [BardErrorInfo: 1167]'), true);
    assert.strictEqual(isConfirmedDeletedError('HTTP 404 Not Found'), true);
    assert.strictEqual(isConfirmedDeletedError('some error', 404), true);

    // Must NOT match 11167 or unrelated BardErrorInfo
    assert.strictEqual(isConfirmedDeletedError('["BardErrorInfo", 11167]'), false);
    assert.strictEqual(classifyDetailError('["BardErrorInfo", 11167]'), 'inaccessible');

    assert.strictEqual(isConfirmedDeletedError('["BardErrorInfo", 500]'), false);
    assert.strictEqual(classifyDetailError('["BardErrorInfo", 500]'), 'inaccessible');

    // Rate limited 1096
    assert.strictEqual(isConfirmedDeletedError('["BardErrorInfo", 1096]'), false);
    assert.strictEqual(classifyDetailError('["BardErrorInfo", 1096]'), 'rate_limited');
    assert.strictEqual(classifyDetailError('Quota exceeded', 429), 'rate_limited');

    // Parse error vs unknown
    assert.strictEqual(classifyDetailError('Unexpected token < in JSON'), 'parse_error');
    assert.strictEqual(classifyDetailError(''), 'unknown');
});

test('Batch 4 - All deletion consumers delegate to canonical protocol classifier', () => {
    const root = path.join(__dirname, '..');
    const clientSrc = fs.readFileSync(path.join(root, 'src/core/api/geminiClient.ts'), 'utf-8');
    const routerSrc = fs.readFileSync(path.join(root, 'src/content/messageRouter.ts'), 'utf-8');
    const workerSrc = fs.readFileSync(path.join(root, 'src/core/engine/export/batchWorker.ts'), 'utf-8');

    assert.ok(clientSrc.includes('classifyDetailError'), 'geminiClient.ts must use classifyDetailError');
    assert.ok(routerSrc.includes('isConfirmedDeletedError'), 'messageRouter.ts must use isConfirmedDeletedError');
    assert.ok(workerSrc.includes('isConfirmedDeletedError'), 'batchWorker.ts must use isConfirmedDeletedError');
});

// =========================================================================
// 2. Pagination Completion Contract (completionReason & isPaginationExhaustive)
// =========================================================================
test('Batch 4 - Pagination completionReason and isPaginationExhaustive contract', async () => {
    const {
        getAllConversations,
        isPaginationExhaustive
    } = require('../src/core/api/client/pagination.js');

    // 1. Natural exhaustion
    const naturalClient = {
        aborted: false,
        getConversationList: async () => ({
            conversations: [{ id: 'c_1', title: 'Chat 1' }],
            nextPageToken: null
        })
    };
    const resNatural = await getAllConversations(naturalClient, 10, null, null, { incremental: true });
    assert.strictEqual(resNatural.completionReason, 'natural_exhaustion');
    assert.strictEqual(resNatural.exhaustive, true);
    assert.strictEqual(resNatural.stoppedEarly, undefined);
    assert.strictEqual(isPaginationExhaustive(resNatural), true);

    // 2. Token loop
    const loopClient = {
        aborted: false,
        getConversationList: async () => ({
            conversations: [{ id: 'c_1', title: 'Chat 1' }],
            nextPageToken: 'tok_loop'
        })
    };
    const resLoop = await getAllConversations(loopClient, 10, null, null, { incremental: true });
    assert.strictEqual(resLoop.completionReason, 'token_loop');
    assert.strictEqual(resLoop.exhaustive, false);
    assert.strictEqual(resLoop.stoppedEarly, true);
    assert.strictEqual(isPaginationExhaustive(resLoop), false);

    // 3. Max pages
    let p = 0;
    const maxPagesClient = {
        aborted: false,
        getConversationList: async () => ({
            conversations: [{ id: `c_${++p}`, title: `Chat ${p}` }],
            nextPageToken: `tok_${p}`
        })
    };
    const resMax = await getAllConversations(maxPagesClient, 2, null, null, { incremental: true });
    assert.strictEqual(resMax.completionReason, 'max_pages');
    assert.strictEqual(resMax.exhaustive, false);
    assert.strictEqual(resMax.stoppedEarly, true);
    assert.strictEqual(isPaginationExhaustive(resMax), false);

    // 4. Watermark unchanged boundary
    const boundaryClient = {
        aborted: false,
        getConversationList: async () => ({
            conversations: [{ id: 'c_1', title: 'Chat 1' }],
            nextPageToken: 'tok_next'
        })
    };
    const resBoundary = await getAllConversations(boundaryClient, 10, null, null, {
        incremental: true,
        onPageBatch: async () => ({ shouldStop: true, reason: 'unchanged' })
    });
    assert.strictEqual(resBoundary.completionReason, 'unchanged_boundary');
    assert.strictEqual(resBoundary.exhaustive, false);
    assert.strictEqual(resBoundary.stoppedEarly, true);
    assert.strictEqual(isPaginationExhaustive(resBoundary), false);
});

// =========================================================================
// 3. JSPB Schema Constants in extractors.ts
// =========================================================================
test('Batch 4 - extractors.ts hasTurnContentMarkers uses GEMINI_JSPB_SCHEMA constants', () => {
    const extractorsPath = path.join(__dirname, '../src/core/api/parser/extractors.ts');
    const src = fs.readFileSync(extractorsPath, 'utf-8');
    const fnMatch = src.match(/function hasTurnContentMarkers[\s\S]*?return false;\s*\}/);
    assert.ok(fnMatch, 'hasTurnContentMarkers must exist in extractors.ts');
    const fnBody = fnMatch[0];
    assert.ok(fnBody.includes('GEMINI_JSPB_SCHEMA.TURN.USER_PAYLOAD'), 'must use TURN.USER_PAYLOAD');
    assert.ok(fnBody.includes('GEMINI_JSPB_SCHEMA.TURN.MODEL_PAYLOAD'), 'must use TURN.MODEL_PAYLOAD');
    assert.ok(fnBody.includes('GEMINI_JSPB_SCHEMA.MODEL_PAYLOAD.CANDIDATES'), 'must use MODEL_PAYLOAD.CANDIDATES');
    assert.ok(fnBody.includes('GEMINI_JSPB_SCHEMA.CANDIDATE.ID'), 'must use CANDIDATE.ID');
    assert.ok(!fnBody.includes('turn[2]') && !fnBody.includes('turn[3]'), 'must not contain bare turn[2] or turn[3] indices');
});

// =========================================================================
// 4. URL Scheme Validation in listView.ts
// =========================================================================
test('Batch 4 - listView restricts conversation URLs to http/https and blocks javascript:/data:', () => {
    const { render } = require('../src/ui/views/listView.js');

    const mockListEl: any = { innerHTML: '', addEventListener: () => {} };
    const mockStatusEl: any = { textContent: '' };
    const elements = new Map<string, any>([
        ['list', mockListEl],
        ['status', mockStatusEl]
    ]);

    const origDocument = (global as any).document;
    (global as any).document = {
        getElementById: (id: string) => elements.get(id) || null
    };

    try {
        const conversations = [
            { id: 'c_evil1', title: 'Evil JS URL', url: 'javascript:alert(1)', timestamp: 1700000000000 },
            { id: 'c_evil2', title: 'Evil Data URL', url: 'data:text/html,<script>alert(1)</script>', timestamp: 1700000000000 },
            { id: 'c_good', title: 'Good HTTPS URL', url: 'https://gemini.google.com/app/c_good', timestamp: 1700000000000 }
        ];

        render(
            conversations,
            {},
            new Set(['c_evil1', 'c_evil2', 'c_good']),
            '',
            'all',
            new Set()
        );

        const html = mockListEl.innerHTML;
        assert.ok(!html.includes('javascript:'), 'must never render javascript: scheme in href');
        assert.ok(!html.includes('data:text/html'), 'must never render data: scheme in href');
        assert.ok(html.includes('href="https://gemini.google.com/app/c_evil1"'), 'must fall back to safe https Gemini URL for c_evil1');
        assert.ok(html.includes('href="https://gemini.google.com/app/c_evil2"'), 'must fall back to safe https Gemini URL for c_evil2');
        assert.ok(html.includes('href="https://gemini.google.com/app/c_good"'), 'must preserve valid https URL');
        assert.ok(html.includes('rel="noopener noreferrer"'), 'must include rel="noopener noreferrer" on external link');
    } finally {
        (global as any).document = origDocument;
    }
});
