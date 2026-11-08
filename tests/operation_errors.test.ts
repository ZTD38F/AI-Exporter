import test from 'node:test';
import assert from 'node:assert/strict';
import { OperationError, operationError, operationIssue, readOperationIssue } from '../src/shared/errors/operationError.js';
import { readSourceExecution } from '../src/l1/client/sourceExecution.js';
import { attemptResource, ResourceHttpError } from '../src/shared/resources/resourceResult.js';
import { readClaudeSource } from '../src/l1/client/claude/claudeSource.js';
import { readGrokSource } from '../src/l1/client/grok/grokSource.js';

test('injected source readers serialize real HTTP and account failures across Chrome', async context => {
    const descriptors = ['chrome', 'document'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    let status = 403;
    let calls = 0;
    context.mock.method(globalThis, 'fetch', async () => {
        calls++;
        return new Response(JSON.stringify({ userId: '22222222-2222-4222-8222-222222222222' }), { status });
    });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { cookie: '' } });
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
        permissions: { contains: async () => true },
        tabs: { query: async () => [{ id: 1 }, { id: 2 }] },
        scripting: { executeScript: async (injection: {
            func: (path: string, owner?: string | null, body?: { responseIds: string[] } | null) => Promise<unknown>;
            args: [string, (string | null)?, ({ responseIds: string[] } | null)?];
        }) => [{ result: JSON.parse(JSON.stringify(await injection.func(...injection.args))) }] },
    } });
    try {
        for (const read of [() => readClaudeSource('/api/organizations'), () => readGrokSource('/rest/auth/get-user')]) {
            for (const httpStatus of [403, 429]) {
                status = httpStatus;
                calls = 0;
                await assert.rejects(read(), error => error instanceof OperationError
                    && error.code === 'SOURCE_HTTP_ERROR' && error.httpStatus === httpStatus);
                assert.equal(calls, httpStatus === 429 ? 1 : 2, 'rate limits must stop tab retries');
            }
        }
        status = 200;
        await assert.rejects(readGrokSource('/rest/auth/get-user', '11111111-1111-4111-8111-111111111111'),
            error => error instanceof OperationError && error.code === 'ACCOUNT_CHANGED');
        Object.defineProperty(globalThis, 'document', { configurable: true,
            value: { cookie: 'lastActiveOrg=22222222-2222-4222-8222-222222222222' } });
        await assert.rejects(readClaudeSource('/api/organizations', '11111111-1111-4111-8111-111111111111'),
            error => error instanceof OperationError && error.code === 'ACCOUNT_CHANGED');
    } finally {
        for (const [name, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
    }
});

test('known causes survive boundary wrapping; unknown text never invents an HTTP status or reason', () => {
    const error = new OperationError('SOURCE_HTTP_ERROR', 'HTTP 403 for conversation abc', 403);
    assert.equal(operationError(error, 'FILE_WRITE_FAILED'), error);
    assert.deepEqual(operationIssue(error), { code: 'SOURCE_HTTP_ERROR', message: error.message, httpStatus: 403 });
    assert.deepEqual(operationIssue(new Error('HTTP 429: login expired')), { code: 'UNKNOWN_ERROR', message: 'HTTP 429: login expired' });
    assert.deepEqual(operationIssue({ arbitrary: true }), { code: 'UNKNOWN_ERROR', message: 'Unknown error' });
    assert.equal(operationIssue(operationError(new Error('close failed'), 'FILE_WRITE_FAILED')).code, 'FILE_WRITE_FAILED');
});

test('Chrome source execution decodes structured HTTP/account failures and rejects invalid envelopes', () => {
    assert.deepEqual(readSourceExecution({ ok: true, value: { data: 1 } }), { data: 1 });
    for (const code of ['SOURCE_HTTP_ERROR', 'ACCOUNT_CHANGED']) {
        assert.throws(() => readSourceExecution({ ok: false, issue: { code, message: 'native fact', httpStatus: 403 } }),
            error => error instanceof OperationError && error.code === code && error.httpStatus === 403);
    }
    for (const invalid of [null, {}, { code: 'made_up', message: 'x' }, { code: 'SOURCE_HTTP_ERROR', message: 'x', httpStatus: '403' }])
        assert.equal(readOperationIssue(invalid), null);
    assert.throws(() => readSourceExecution({ ok: false, issue: { code: 'made_up', message: 'x' } }),
        error => error instanceof OperationError && error.code === 'SOURCE_RESPONSE_INVALID');
});

test('resource preparation retains typed failures and actual HTTP statuses without consuming cancellation', async () => {
    const http = await attemptResource('img', async () => { throw new ResourceHttpError(404); });
    assert.equal(http.ok, false);
    if (!http.ok) assert.deepEqual(http.issue, { code: 'RESOURCE_SOURCE_EXPIRED', message: 'Resource request failed: HTTP 404', httpStatus: 404 });
    const size = await attemptResource('file', async () => { throw new OperationError('RESOURCE_SIZE_LIMIT', 'limit exceeded'); });
    assert.equal(size.ok, false);
    if (!size.ok) assert.equal(size.issue?.code, 'RESOURCE_SIZE_LIMIT');
    await assert.rejects(attemptResource('cancel', async () => { throw new DOMException('cancelled', 'AbortError'); }), /cancelled/);
});
