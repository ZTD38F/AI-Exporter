import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGeminiDomIndex } from '../src/l1/parsers/gemini/dom/parseIndex.js';
import { isReservedRoute } from '../src/shared/utils/pathUtils.js';

test('only current-page Gemini metadata is read; history is not expanded or scrolled', () => {
    const doc = {
        title: 'Current page title',
        querySelectorAll: (selector: string) => {
            if (selector.includes('conversation-title')) return [{ textContent: 'Current page title' }];
            if (selector === 'user-query, model-response') return [{}, {}];
            return [];
        },
        querySelector: () => null,
        scroll: () => { throw new Error('Must not scroll history'); },
    } as unknown as Document;
    assert.deepEqual(parseGeminiDomIndex(doc, 'current_conversation'), {
        id: 'current_conversation', title: 'Current page title', titleSource: 'dom', messageCount: 2,
    });
});

test('reserved route names are not valid conversation identities', () => {
    for (const id of ['download', 'c_settings', 'trash', 'explore']) assert.equal(isReservedRoute(id), true);
    for (const id of ['c_1bd028d5c5b0c0e2', 'normal_chat_id', '', null]) assert.equal(isReservedRoute(id), false);
});
