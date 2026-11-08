import { fixtureAccount, fixtureAccountFor } from './helpers/domainFixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGeminiRpcConversation } from '../src/l1/parsers/gemini/rpc/parseConversation.js';
import { decodeGeminiDetail } from '../src/l1/parsers/gemini/rpc/detailDecoder.js';
import { textOfBlocks } from './helpers/contentText.js';
import { detailGen as geminiDetailGen } from './fixtures/providers/geminiDetail.js';

// Sanitized shape observed in the failing 2026-10-09 Tier 2 spray-dryer RPC:
// one request, two answer drafts, turn[3][3] naming the displayed candidate.
const ID = 'c_selected12345678';
const candidates = [
    ['rc_displayed', [['## System Definition and Mass Balances\n\nDisplayed balance.']]],
    ['rc_alternative', [['## System Boundaries and Assumptions\n\nUnselected balance.']]],
];
const parse = (wire: string) => parseGeminiRpcConversation(wire, { account: fixtureAccount('gemini'), providerId: 'gemini' });
const answerText = (wire: string) => textOfBlocks(parse(wire).conversation.detail.messages[1].content);

test('selected wire answer exports one Assistant section and retains raw alternative evidence', () => {
    const wire = geminiDetailGen('G_SELECTED_CANDIDATE_01');
    const result = parse(wire);
    assert.deepEqual(result.conversation.detail.messages.map(m => [m.role, m.id]), [['user', 'r_request'], ['assistant', 'rc_displayed']]);
    assert.match(answerText(wire), /Displayed balance/);
    assert.doesNotMatch(answerText(wire), /Unselected balance/);
    assert.equal(result.conversation.detail.messages.filter(message => message.role === 'assistant').length, 1);
    const raw = result.transport.decodedPayload as unknown[][];
    assert.deepEqual(raw[0][0], [[ID, 'r_request'], [1700000000, 0], [['Derive the mass balance.']], [candidates, null, null, 'rc_displayed']]);
});

test('selection is by candidate identity even when the displayed answer is not first', () => {
    const wire = geminiDetailGen('G_SELECTED_CANDIDATE_02');
    assert.equal(parse(wire).conversation.detail.messages[1].id, 'rc_alternative');
    assert.match(answerText(wire), /Unselected balance/);
    assert.doesNotMatch(answerText(wire), /Displayed balance/);
});

test('legacy missing, telemetry and unknown selections use a single primary draft', () => {
    for (const key of ['G_SELECTED_CANDIDATE_03', 'G_SELECTED_CANDIDATE_04',
        'G_SELECTED_CANDIDATE_05', 'G_SELECTED_CANDIDATE_06'] as const) {
        const parsed = decodeGeminiDetail(geminiDetailGen(key));
        assert.equal(parsed.messages.length, 2);
        assert.equal(parsed.messages[1].id, 'rc_displayed');
    }
});

test('unselected images do not leak into the selected answer or consume its resources', () => {
    const unselectedImage = 'https://lh3.googleusercontent.com/unselected-image.png';
    const selectedImage = 'https://lh3.googleusercontent.com/selected-image.png';
    const wire = geminiDetailGen('G_SELECTED_CANDIDATE_07');
    const parsed = decodeGeminiDetail(wire);
    assert.equal(parsed.messages.length, 2);
    assert.equal(parsed.messages[1].id, 'rc_selected');
    assert.equal(parsed.messages[1].images?.length, 1);
    assert.equal(parsed.messages[1].images?.[0].sourceUrl, selectedImage);

    // Resource ownership must survive the native Domain boundary, not just decoding.
    const domain = parse(wire).conversation;
    assert.ok(domain.detail.assets.some(asset => asset.sourceUri === selectedImage));
    assert.ok(!domain.detail.assets.some(asset => asset.sourceUri === unselectedImage));
    assert.equal(domain.detail.messages.filter(message => message.role === 'assistant').length, 1);
});
