import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeGeminiDetail } from '../src/l1/parsers/gemini/rpc/detailDecoder.js';
import { parseGeminiRpcConversation } from '../src/l1/parsers/gemini/rpc/parseConversation.js';
import { mergeConversationPages } from '../src/l1/parsers/gemini/rpc/mergePages.js';

import { detailGen } from './fixtures/providers/geminiDetail.js';

test('unidentified metadata and non-array junk are discarded, counted, and never assigned a role', () => {
    for (const key of ['G_TURN_ADMISSION_METADATA', 'G_TURN_ADMISSION_SCALAR', 'G_TURN_ADMISSION_UNOWNED'] as const) {
        const evidence = decodeGeminiDetail(detailGen(key));
        assert.equal(evidence.turnsRejected, 1);
        assert.equal(evidence.turnsRecovered, undefined);
        assert.deepEqual(evidence.messages.map(message => [message.role, message.content]), [
            ['user', 'Real question'], ['model', 'Real answer'],
        ]);
        const parsed = parseGeminiRpcConversation(detailGen(key), { providerId: 'gemini' });
        assert.equal(parsed.evidence?.rejectedTurns, 1);
        assert.equal(parsed.conversation.detail.quality.status, 'partial');
    }
});

test('request-bound drift is recovered separately from discarded turns and stays partial after pagination', () => {
    const recovered = detailGen('G_TURN_ADMISSION_REQUEST_RECOVERY');
    const evidence = decodeGeminiDetail(recovered);
    assert.equal(evidence.turnsRejected, undefined);
    assert.equal(evidence.turnsRecovered, 1);
    assert.equal(evidence.messages[0].content, 'Recovered question');
    assert.equal(evidence.messages[0].id, 'r_recovered');
    assert.ok(evidence.schemaDrift?.some(warning => warning.includes('Turn ID meta')));
    const parsed = parseGeminiRpcConversation(recovered, { providerId: 'gemini' });
    assert.equal(parsed.evidence?.rejectedTurns, undefined);
    assert.equal(parsed.conversation.detail.quality.status, 'partial');
    assert.ok(parsed.diagnostics.some(diagnostic => diagnostic.code === 'GEMINI_TURNS_RECOVERED'));
    assert.equal(mergeConversationPages([parsed], undefined, true).conversation.detail.quality.status, 'partial');
});

test('candidate-bound drift preserves the answer without requiring an intact conversation header', () => {
    const recovered = detailGen('G_TURN_ADMISSION_CANDIDATE_RECOVERY');
    const evidence = decodeGeminiDetail(recovered);
    assert.equal(evidence.turnsRejected, undefined);
    assert.equal(evidence.turnsRecovered, 1);
    assert.equal(evidence.messages[0].role, 'model');
    assert.equal(evidence.messages[0].id, 'rc_recovered');
    assert.equal(evidence.messages[0].content, 'Recovered answer');
});
