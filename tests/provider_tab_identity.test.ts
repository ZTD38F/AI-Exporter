import test from 'node:test';
import assert from 'node:assert/strict';
import { readClaudeSource } from '../src/l1/client/claude/claudeSource.js';
import { readClaudeFile } from '../src/l1/client/claude/fileAssets.js';
import { readGrokSource } from '../src/l1/client/grok/grokSource.js';

for (const [provider, read] of [
    ['Claude', () => readClaudeSource('/api/organizations')],
    ['Grok', () => readGrokSource('/rest/auth/get-user')],
] as const) test(`${provider} skips ID-less tabs, tries active tabs first and falls back to ID zero`, async t => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
    t.after(() => {
        if (original) Object.defineProperty(globalThis, 'chrome', original);
        else Reflect.deleteProperty(globalThis, 'chrome');
    });
    const calls: number[] = [];
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
        permissions: { contains: async () => true },
        tabs: { query: async () => [{ id: 0 }, { active: true }, { id: 2, active: true }, { id: 3 }] },
        scripting: { executeScript: async ({ target }: { target: { tabId: number } }) => {
            calls.push(target.tabId);
            if (target.tabId === 2) throw new Error('Tab closed');
            return [{ result: { ok: true, value: { source: provider } } }];
        } },
    } });
    assert.deepEqual(await read(), { source: provider });
    assert.deepEqual(calls, [2, 0]);
});

test('Claude attachments accept ID zero and reject a tab list without IDs before injection', async t => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
    t.after(() => {
        if (original) Object.defineProperty(globalThis, 'chrome', original);
        else Reflect.deleteProperty(globalThis, 'chrome');
    });
    let tabs: Array<{ id?: number; active?: boolean }> = [{ active: true }, { id: 0 }];
    let calls = 0;
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
        permissions: { contains: async () => true }, tabs: { query: async () => tabs },
        scripting: { executeScript: async ({ target }: { target: { tabId: number } }) => {
            calls++; assert.equal(target.tabId, 0);
            return [{ result: { status: 200, base64: 'AQI=', mediaType: 'application/octet-stream' } }];
        } },
    } });
    const id = '11111111-1111-4111-8111-111111111111';
    const result = await readClaudeFile(id, id);
    assert.deepEqual(result.bytes, new Uint8Array([1, 2]));
    tabs = [{ active: true }];
    await assert.rejects(readClaudeFile(id, id), /Open Claude/);
    assert.equal(calls, 1);
});
