/**
 * P1-G type regression contracts.
 *
 * Compile-time contracts are checked by 'npm run type-check', not by the
 * Node test runner. Keep them in an uncalled function so no tautological
 * runtime tests ("assign a value, then read it back") inflate test counts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { historicalFixture } from './helpers/nativeFixture.js';
import type { HistoricalConversation as Conversation } from './helpers/historicalConversation.js';
import type { ChatMessage, Attachment } from './helpers/historicalConversation.js';

// P1-090, 091, 093, 098, 099, 100 are type-check contracts.
// The @ts-expect-error directives fail compilation if forbidden types
// become legal again, so they are intentionally not runtime assertions.
function typecheckContracts(): void {
    const fromParser: ChatMessage = { role: 'model', content: 'hi', thoughts: 'joined thoughts' };
    const fromOtherProvider: ChatMessage = { role: 'model', content: 'hi', thoughts: ['a', 'b'] };

    // P1-091: core types must reject undeclared fields.
    // @ts-expect-error - arbitrary Conversation fields must not be legal
    type _NoConversationIndex = Conversation['someUndeclaredProp'];
    // @ts-expect-error - arbitrary ChatMessage fields must not be legal
    type _NoMessageIndex = ChatMessage['anotherUndeclaredProp'];

    const message: ChatMessage = {
        role: 'model', content: 'x',
        images: [{ type: 'image', fileName: 'a.png', localName: 'assets/a.png' }],
        thinking: 'legacy thought text',
        attachmentCount: 2,
    };
    const conversation: Conversation = {
        id: 'c_1', title: 't', timestamp: 123,
        attachmentCount: 2, messageCount: 5,
        href: 'https://gemini.google.com/app/c_1',
        hasExplicitPrompt: true,
    };
    const attachment: Attachment = {
        type: 'image', name: 'alt', isGenerated: true,
        isImage: true, subDir: 'assets', source: 'takeout'
    };

    type IsAny<T> = 0 extends (1 & T) ? true : false;

    // P1-099: removed ambient globals must stay gone and the one retained
    // global API client declaration must not revert to any.
    // @ts-expect-error - removed global must not become ambient again
    type _NoBadgeView = typeof BadgeView;
    const clientMustBeTyped: IsAny<typeof GeminiAPIClient> = false;

    // P1-100: these model types must not reappear in the public API.
    // @ts-expect-error - deleted public type
    type _NoThoughtBlock = import('./helpers/historicalConversation.js').ThoughtBlock;
    // @ts-expect-error - deleted public type
    type _NoCitationSource = import('./helpers/historicalConversation.js').CitationSource;

    void fromParser; void fromOtherProvider;
    void message; void conversation; void attachment;
    void clientMustBeTyped;
}
void typecheckContracts;

// P1-094: the live Takeout parse error retains the shared hierarchy.
test('P1-094: TakeoutParseError extends GeminiError and retired RPC error is absent', () => {
    const errors = require('../src/shared/types/errors.js');
    assert.equal(errors.GeminiRpcError, undefined);
    assert.equal(typeof errors.GeminiError, 'function');
    assert.ok(new errors.TakeoutParseError('x') instanceof errors.GeminiError);
});

// P1-097: a removed unused file is not a runtime contract; deleted.
// P1-101: a particular unused import is not runtime behavior; deleted.
