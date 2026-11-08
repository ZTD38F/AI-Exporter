import { fixtureAccount, fixtureAccountFor } from './helpers/domainFixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGeminiRpcConversation } from '../src/l1/parsers/gemini/rpc/parseConversation.js';
import { parseMarkdownToBlocks } from '../src/l1/parsers/shared/markdown/index.js';
import { textOfBlocks } from './helpers/contentText.js';
import { detailGen as geminiDetailGen } from './fixtures/providers/geminiDetail.js';

test('native Gemini prompts preserve literal syntax while assistant Markdown remains structured', () => {
    const prompt = String.raw`Use f(\$)=1, **literal**, $x$, <input> and C:\temp\file.

Keep [link](https://example.com) and \* intact.`;
    const wire = geminiDetailGen('G_PROMPT_LITERAL_01');
    const { conversation } = parseGeminiRpcConversation(wire, { account: fixtureAccount('gemini'), providerId: 'gemini' });
    const user = conversation.detail.messages[0];
    assert.equal(user.role, 'user');
    assert.equal(textOfBlocks(user.content), prompt);
    assert.ok(user.content.every(block => block.type === 'paragraph'));
    const answer = conversation.detail.messages[1];
    assert.ok(answer.content.some(block => block.type === 'paragraph' && block.children.some(node => node.type === 'strong')));
    assert.equal('key' in conversation.detail, false);
});
