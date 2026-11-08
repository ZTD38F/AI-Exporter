import { fixtureAccount } from './helpers/domainFixture.js';
import { fixtureAccountFor, fixtureKey } from './helpers/domainFixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { historicalFixture } from './helpers/nativeFixture.js';
import { restoreDomainSnapshot } from '../src/l2/runtimeValidation.js';
import { composeDomainDocument } from '../src/l3b/compose/composeDomainDocument.js';

const captured = () => historicalFixture({ id: 'upgraded', title: 'Snapshot title', messages: [{ role: 'assistant', content: 'Saved body' }] });

test('AST: Index owns exported metadata while the body version remains capture evidence', () => {
    const parsed = {   ...captured(), sourceVersion: 100 };
    parsed.conversation.index.title = 'Current rename';
    parsed.conversation.index.updatedAt = 200;
    const document = composeDomainDocument(parsed.conversation, fixtureAccountFor(parsed.conversation));
    assert.equal(document.title, 'Current rename');
    assert.equal(document.metadata?.updatedAt, 200);
});
