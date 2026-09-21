export {};
const test = require('node:test');
const assert = require('node:assert');

test('errors - GeminiError and error hierarchy inheritance', () => {
    const {
        GeminiError,
        GeminiRpcError,
        ExportPipelineError,
        TakeoutParseError,
        StorageError
    } = require('../src/types/errors.js');

    // 1. Root GeminiError
    const rootErr = new GeminiError('Root error');
    assert.ok(rootErr instanceof Error);
    assert.ok(rootErr instanceof GeminiError);
    assert.strictEqual(rootErr.name, 'GeminiError');
    assert.strictEqual(rootErr.message, 'Root error');

    // 2. GeminiRpcError
    const rpcErr = new GeminiRpcError('Rate limit exceeded', 429, 'batchexecute');
    assert.ok(rpcErr instanceof GeminiError);
    assert.ok(rpcErr instanceof GeminiRpcError);
    assert.strictEqual(rpcErr.statusCode, 429);
    assert.strictEqual(rpcErr.rpcName, 'batchexecute');
    assert.strictEqual(rpcErr.isRateLimit, true);

    const rpcErrOther = new GeminiRpcError('Server error', 500);
    assert.strictEqual(rpcErrOther.isRateLimit, false);

    // 3. ExportPipelineError
    const pipeErr = new ExportPipelineError('Permission denied', 'chat_123', 'write', true);
    assert.ok(pipeErr instanceof GeminiError);
    assert.strictEqual(pipeErr.chatId, 'chat_123');
    assert.strictEqual(pipeErr.step, 'write');
    assert.strictEqual(pipeErr.isPermissionRevoked, true);

    // 4. TakeoutParseError
    const takeoutErr = new TakeoutParseError('Structure changed', true, 'MyActivity.html');
    assert.ok(takeoutErr instanceof GeminiError);
    assert.strictEqual(takeoutErr.formatDrift, true);
    assert.strictEqual(takeoutErr.entryName, 'MyActivity.html');

    // 5. StorageError
    const storageErr = new StorageError('Quota exceeded', 'set', 'gemini_conversations');
    assert.ok(storageErr instanceof GeminiError);
    assert.strictEqual(storageErr.operation, 'set');
    assert.strictEqual(storageErr.key, 'gemini_conversations');
});

test('messaging - getErrorMessage safely normalizes all error types', () => {
    const { getErrorMessage } = require('../src/core/utils/messaging.js');
    const utils = require('../src/core/utils/utils.js');

    assert.strictEqual(getErrorMessage('Simple error string'), 'Simple error string');
    assert.strictEqual(getErrorMessage(new Error('Standard Error object')), 'Standard Error object');
    assert.strictEqual(getErrorMessage({ message: 'Custom object message' }), 'Custom object message');
    assert.strictEqual(getErrorMessage(null), 'Unknown error');
    assert.strictEqual(getErrorMessage(undefined), 'Unknown error');
    assert.strictEqual(getErrorMessage(404), '404');

    // Verify GeminiUtils facade re-export
    assert.strictEqual(typeof utils.getErrorMessage, 'function');
    assert.strictEqual(utils.getErrorMessage(new Error('Facade test')), 'Facade test');
});

test('messaging - isMessageAction type guard filters actions correctly', () => {
    const { isMessageAction } = require('../src/core/utils/messaging.js');

    assert.strictEqual(isMessageAction({ action: 'ping' }, 'ping'), true);
    assert.strictEqual(isMessageAction({ action: 'sync' }, 'ping'), false);
    assert.strictEqual(isMessageAction(null, 'ping'), false);
    assert.strictEqual(isMessageAction('string', 'ping'), false);
    assert.strictEqual(isMessageAction({}, 'ping'), false);
});

test('messaging - sendTypedMessage resolves response or handles chrome runtime errors', async () => {
    const { sendTypedMessage } = require('../src/core/utils/messaging.js');

    // Case 1: chrome runtime missing
    const origChrome = (global as any).chrome;
    delete (global as any).chrome;
    await assert.rejects(
        async () => {
            await sendTypedMessage({ action: 'test' });
        },
        (err: any) => err.message.includes('Chrome runtime messaging is not available')
    );

    // Case 2: successful response
    (global as any).chrome = {
        runtime: {
            sendMessage: (msg: any, cb: (res: any) => void) => {
                cb({ success: true, echoed: msg.action });
            }
        }
    };
    const res = await sendTypedMessage({ action: 'echoTest' });
    assert.deepStrictEqual(res, { success: true, echoed: 'echoTest' });

    // Case 3: runtime.lastError
    (global as any).chrome = {
        runtime: {
            lastError: { message: 'Receiving end does not exist' },
            sendMessage: (_msg: any, cb: (res: any) => void) => {
                cb(undefined);
            }
        }
    };
    await assert.rejects(
        async () => {
            await sendTypedMessage({ action: 'failingAction' });
        },
        (err: any) => err.message.includes('Receiving end does not exist')
    );

    // Restore chrome
    if (origChrome) (global as any).chrome = origChrome;
    else delete (global as any).chrome;
});

test('utils facade - modular sub-utilities re-exported with full compatibility', () => {
    const utils = require('../src/core/utils/utils.js');

    // Title utils
    assert.strictEqual(typeof utils.cleanTitle, 'function');
    assert.strictEqual(typeof utils.isRealTitle, 'function');
    assert.strictEqual(typeof utils.resolveTitle, 'function');
    assert.strictEqual(typeof utils.setTitleBySource, 'function');

    // Path utils
    assert.strictEqual(typeof utils.sanitizeFileName, 'function');
    assert.strictEqual(typeof utils.sanitizeRelativePath, 'function');
    assert.strictEqual(typeof utils.normId, 'function');
    assert.strictEqual(utils.sanitizeFileName('foo/bar:*?"<>|'), 'foo_bar');

    // Progress utils
    assert.strictEqual(typeof utils.formatExportProgress, 'function');
    const formatted = utils.formatExportProgress({ pct: 50, current: 5, total: 10 });
    assert.strictEqual(formatted.pct, 50);

    // Merge utils
    assert.strictEqual(typeof utils.mergeConversation, 'function');
    assert.strictEqual(typeof utils.deduplicateConversations, 'function');
});
