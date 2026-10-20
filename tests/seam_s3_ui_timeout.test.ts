import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

// S3: UI -> background hops must carry their own timeout so a lost response
// can never wedge UI state (stuck scanRunning / stuck P1-123 export guard).

// ---- Part 1: the mechanism (sendTypedMessage timeout) ---------------------

function mockChrome(impl: { sendMessage: (msg: any, cb: any) => void }) {
    (global as any).chrome = {
        runtime: {
            sendMessage: impl.sendMessage,
            lastError: null,
        },
    };
}

const { sendTypedMessage } = require('../src/core/utils/messaging.ts');

test('S3 - sendTypedMessage resolves when the response arrives', async () => {
    mockChrome({
        sendMessage: (_msg: any, cb: any) => { cb({ ok: true }); },
    });
    const res: any = await sendTypedMessage({ action: 'ping' }, 1000);
    assert.strictEqual(res.ok, true);
});

test('S3 - sendTypedMessage rejects on timeout when the response never arrives', async () => {
    mockChrome({
        sendMessage: (_msg: any, _cb: any) => { /* never calls back: SW evicted */ },
    });
    await assert.rejects(
        sendTypedMessage({ action: 'deepScan' }, 50),
        /timeout/,
        'a lost response must reject, not hang forever'
    );
});

test('S3 - sendTypedMessage rejects on chrome.runtime.lastError', async () => {
    mockChrome({
        sendMessage: (_msg: any, cb: any) => {
            (global as any).chrome.runtime.lastError = { message: 'Receiving end does not exist.' };
            cb();
            (global as any).chrome.runtime.lastError = null;
        },
    });
    await assert.rejects(sendTypedMessage({ action: 'ping' }, 1000), /Receiving end/);
});

// ---- Part 2: the two hanging callers now use it ----------------------------

const SRC = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('S3 - options deepScan goes through sendTypedMessage with an explicit timeout', () => {
    const code = SRC('src/ui/controllers/syncController.ts');
    assert.ok(code.includes("import { sendTypedMessage } from '../../core/utils/messaging.js'"));
    assert.ok(
        /sendTypedMessage\(\{\s*action:\s*'deepScan'[^)]+},\s*\w+\s*\)/.test(code) ||
        (/action:\s*'deepScan'/.test(code) && /sendTypedMessage\(\s*\w+,\s*\w+\s*\)/.test(code)),
        'deepScan passes an explicit timeout'
    );
    // The stuck-state fix: the rejection path must also clear scanRunning.
    const catchIdx = code.indexOf('.catch((err: any) => {');
    assert.ok(catchIdx > 0, 'deepScan has a rejection handler');
    const catchBody = code.slice(catchIdx, catchIdx + 400);
    assert.ok(catchBody.includes('setScanRunning(false)'), 'rejection clears scanRunning');
});

test('S3 - popup fetchChat goes through sendTypedMessage with an explicit timeout', () => {
    const code = SRC('src/ui/popup/popup.ts');
    assert.ok(code.includes("import { sendTypedMessage } from '../../core/utils/messaging.js'"));
    assert.ok(
        /sendTypedMessage\(\{\s*action:\s*'fetchChat'[^)]+},\s*40000\s*\)/.test(code),
        'fetchChat passes a 40s timeout'
    );
    const catchIdx = code.indexOf('}).catch((err: any) => {');
    assert.ok(catchIdx > 0, 'fetchChat has a rejection handler');
    const catchBody = code.slice(catchIdx, catchIdx + 400);
    assert.ok(catchBody.includes('__releaseExportGuard()'), 'rejection releases the P1-123 guard');
});
