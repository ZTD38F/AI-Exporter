import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeVisitSave } from '../src/runtime/content/claudeVisitSave.js';
import type { GlobalSettings } from '../src/application/settings/index.js';

const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const enabled: GlobalSettings = { enabledDisk: true, exportDelivery: 'folderWriter', defaultFormat: 'markdown',
    skipExported: true, includeAssets: true, developerMode: false };

test('Claude SSR visit save requires effective opt-in and coalesces repeated initialization', async () => {
    let settings = { ...enabled, enabledDisk: false };
    let identities = 0, saves = 0;
    const controller = createClaudeVisitSave({ path: () => '/chat/' + first,
        settings: async () => settings, account: async () => { identities++; return { id: 'account' }; },
        save: async (key, refresh) => { saves++; assert.equal(key.conversationId, first); assert.equal(refresh, true); } });
    await controller.save();
    assert.equal(identities, 0, 'disabled Live Save does not even acquire source identity');
    settings = { ...enabled, exportDelivery: 'browserDownload' };
    await controller.save();
    assert.equal(identities, 0, 'browser download is not effective Live Save');
    settings = enabled;
    await Promise.all([controller.save(), controller.save(), controller.save()]);
    assert.equal(identities, 1);
    assert.equal(saves, 1);
    await controller.save();
    assert.equal(saves, 1, 'no source polling or retries during one visit');
});

test('Claude native detail capture suppresses redundant SSR acquisition', async () => {
    let saves = 0;
    const controller = createClaudeVisitSave({ path: () => '/chat/' + first, settings: async () => enabled,
        account: async () => ({ id: 'account' }), save: async () => { saves++; } });
    controller.nativeDetail(first);
    await controller.save();
    assert.equal(saves, 0);
});

test('Claude navigation cancels delayed old identity and only saves the current visit', async () => {
    let path = '/chat/' + first;
    let resolve!: (value: { id: string }) => void;
    const identity = new Promise<{ id: string }>(r => { resolve = r; });
    const saved: string[] = [];
    const controller = createClaudeVisitSave({ path: () => path, settings: async () => enabled,
        account: () => identity, save: async key => { saved.push(key.conversationId); } });
    const old = controller.save();
    await Promise.resolve();
    path = '/chat/' + second;
    controller.observe(path);
    resolve({ id: 'account' });
    await old;
    assert.deepEqual(saved, []);
    await controller.save();
    assert.deepEqual(saved, [second]);
});

test('Claude failed visit acquisition is not retried and non-conversation routes never save', async () => {
    let path = '/chat/' + first, attempts = 0;
    const controller = createClaudeVisitSave({ path: () => path, settings: async () => enabled,
        account: async () => ({ id: 'account' }), save: async () => { attempts++; throw new Error('HTTP 429'); } });
    await assert.rejects(controller.save(), /HTTP 429/);
    await controller.save();
    assert.equal(attempts, 1);
    path = '/new'; controller.observe(path);
    await controller.save();
    assert.equal(attempts, 1);
});

test('Claude disabling Live Save while identity resolves prevents acquisition', async () => {
    let settings = enabled, saved = false;
    const controller = createClaudeVisitSave({ path: () => '/chat/' + first, settings: async () => settings,
        account: async () => { settings = { ...enabled, enabledDisk: false }; return { id: 'account' }; },
        save: async () => { saved = true; } });
    await controller.save();
    assert.equal(saved, false);
});
