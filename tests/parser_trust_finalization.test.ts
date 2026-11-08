import { fixtureKey, fixtureAccount } from './helpers/domainFixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLegacyStorageConversation } from './helpers/recordFixture/parseConversation.js';
import { validateParserDomain, restoreDomainSnapshot } from '../src/l2/runtimeValidation.js';

test('source identity semantics remain separate from nonempty storage identity', () => {
    const source = { index: { key: fixtureKey(String(''), 'future'),   titleSource: "derived" as const,   title: '' }, detail: { key: fixtureKey(String(''), 'future'), quality: { status: 'unknown' } as const, assets: [], messages: [] } };
    assert.throws(() => validateParserDomain(source), /index|key/);
    assert.throws(() => restoreDomainSnapshot(source), /index|key/);
});
test('legacy coverage corrections are included in the finalized Domain', () => {
    const result = parseLegacyStorageConversation({ metadata: { id: 'old', messageCount: 2 } }, { account: fixtureAccount('gemini'), providerId: 'gemini' });
    assert.equal(result.conversation.detail.quality.status, 'partial');
    assert.equal(result.diagnostics[0].code, 'LEGACY_BODY_NOT_STORED');
    const corrected = parseLegacyStorageConversation({ metadata: { id: 'old', messages: [{ role: 'user', content: 'Preserved' }] } },
        { account: fixtureAccount('gemini'), providerId: 'gemini', qualityStatusOverride: 'partial' });
    assert.deepEqual(corrected.conversation.detail.quality.status, 'partial');
    assert.equal(corrected.conversation.detail.messages.length, 1);
});
