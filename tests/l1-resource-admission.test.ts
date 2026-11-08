import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceResourceContext } from '../src/l1/resources/sourceResources.js';
import type { SourceConversationParseResult } from '../src/l1/parsers/parsingResult.js';

const key = { accountId: '10000000-0000-4000-8000-000000000001', conversationId: 'conversation-1' };
const asset = { id: 'image', kind: 'image' as const };
function parsed(text: string, inline: string | undefined): SourceConversationParseResult {
    return {
        conversationId: key.conversationId,
        conversation: {
            index: {},
            detail: {
                messages: [{ role: 'assistant', content: [{ type: 'paragraph', children: [{ type: 'text', text }] }] }],
                assets: [asset], quality: { status: 'complete' },
            },
        },
        acquisitionHints: inline === undefined ? {} : { image: { dataBase64: Buffer.from(inline).toString('base64') } },
        diagnostics: [],
    };
}

test('admitted replacement never mixes resource bytes from different Detail candidates', async () => {
    const resources = createSourceResourceContext();
    try {
        // L1 callers invoke retainParsed only after L2 accepts the candidate.
        resources.retainParsed(key, parsed('first body', 'first bytes'));
        assert.equal(Buffer.from((await resources.acquire(key, asset)).bytes).toString(), 'first bytes');
        resources.retainParsed(key, parsed('second body', 'second bytes'));
        assert.equal(Buffer.from((await resources.acquire(key, asset)).bytes).toString(), 'second bytes');
        resources.retainParsed(key, parsed('third body', undefined));
        await assert.rejects(resources.acquire(key, asset), /No supported source locator/);
    } finally {
        resources.release();
    }
});

test('task resource readers remain isolated by full account/conversation identity', async () => {
    const resources = createSourceResourceContext();
    const other = { accountId: '10000000-0000-4000-8000-000000000002', conversationId: key.conversationId };
    try {
        resources.retainParsed(key, parsed('first', 'account-one'));
        resources.retainParsed(other, parsed('second', 'account-two'));
        assert.equal(Buffer.from((await resources.acquire(key, asset)).bytes).toString(), 'account-one');
        assert.equal(Buffer.from((await resources.acquire(other, asset)).bytes).toString(), 'account-two');
        resources.releaseConversation(key);
        await assert.rejects(resources.acquire(key, asset), /No supported source locator/);
        assert.equal(Buffer.from((await resources.acquire(other, asset)).bytes).toString(), 'account-two');
    } finally {
        resources.release();
    }
});
