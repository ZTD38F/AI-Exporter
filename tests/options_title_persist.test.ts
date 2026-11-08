import test from 'node:test';
import assert from 'node:assert/strict';
import type { DomainConversationIndex } from '../src/l2/conversationIndex.js';
import { A, B, assertUiNodeIsolation, installUiV2Mocks } from './helpers/uiV2Mocks.js';

// This UI view-state test must not load the L2 ingestion fixture.
installUiV2Mocks();
const { ConversationViewState } = require('../src/ui/options/state/conversationsStore.js') as
    typeof import('../src/ui/options/state/conversationsStore.js');
assertUiNodeIsolation();
const accounts = [A, B].map(id => ({ id, providerId: 'gemini', providerAccountId: id }));
test('export view refresh reads accepted Index without publishing metadata', async () => {
    const accepted = { key: { accountId: A, conversationId: 'chat' }, title: 'Accepted', titleSource: 'provider' as const, createdAt: 10, updatedAt: 20 };
    const state = new ConversationViewState({ listAccounts: async () => accounts, listIndexes: async id => { assert.equal(id, A); return [accepted]; }, listExportRecords: async () => ({}) });
    await state.refresh(); assert.deepEqual(state.indexes, [accepted]); assert.equal(state.selected.size, 0);
    // Only read ports exist on the UI state: there is no metadata write fallback.
    assert.equal(Object.hasOwn(state, 'updateConversation'), false);
});
test('late export refresh cannot overwrite the newly selected account', async () => {
    let release!: (rows: DomainConversationIndex[]) => void, entered!: () => void;
    const old = new Promise<DomainConversationIndex[]>(resolve => { release = resolve; }), arrived = new Promise<void>(resolve => { entered = resolve; });
    const state = new ConversationViewState({ listAccounts: async () => accounts, listExportRecords: async () => ({}),
        listIndexes: async id => { if (id === A) { entered(); return old; } return [{ key: { accountId: B, conversationId: 'chat' }, title: 'Other account' }]; } });
    const pending = state.refresh(); await arrived; state.selectAccount(B); await state.refresh();
    release([{ key: { accountId: A, conversationId: 'chat' }, title: 'Original account' }]); await pending;
    assert.equal(state.accountId, B); assert.equal(state.indexes[0].title, 'Other account');
});
