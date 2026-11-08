import { fixtureAccount, fixtureAccountFor } from './helpers/domainFixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseGeminiRpcConversation } from '../src/l1/parsers/gemini/rpc/parseConversation.js';
import { decodeCandidateArtifacts } from '../src/l1/parsers/gemini/rpc/candidateArtifacts.js';
import { detailGen as geminiDetailGen } from './fixtures/providers/geminiDetail.js';

const fixture = JSON.parse(readFileSync('tests/fixtures/provider/gemini_generated_file.json', 'utf8')) as { packet: unknown[]; chip: unknown[] };
const packet = fixture.packet;
test('generated file stays on its source turn, retains chip position, and carries exact UTF-8 source bytes', () => {
    const input = geminiDetailGen('G_GENERATED_FILES_01');
    const result = parseGeminiRpcConversation(input, { account: fixtureAccount('gemini'), providerId: 'gemini', targetConvId: 'e6dc4e0732ba568b' });
    const { conversation } = result;
    assert.equal(conversation.detail.assets.length, 1, 'no heuristic duplicate or cross-turn document');
    const asset = conversation.detail.assets[0];
    assert.equal(asset.name, packet[9]);
    const bytes = Uint8Array.from(atob(result.acquisitionHints[asset.id].dataBase64!), value => value.charCodeAt(0));
    assert.equal(new TextDecoder().decode(bytes), (packet[32] as unknown[])[2]);
    const earlier = conversation.detail.messages.find(message => message.id === 'rc_earlier')!;
    assert.equal(earlier.attachmentIds?.length ?? 0, 0);
    assert.deepEqual(earlier.content.map(node => node.type), ['paragraph']);
    const later = conversation.detail.messages.find(message => message.id === 'rc_later')!;
    assert.deepEqual(later.content.map(node => node.type), ['paragraph', 'file', 'paragraph']);
    assert.equal('key' in conversation.detail, false);
    assert.equal(later.attachmentIds?.[0], asset.id);

});
test('unknown file packet versions and absent content never fabricate an attachment', () => {
    for (const mutate of ['type', 'content'] as const) {
        const row = structuredClone(packet);
        if (mutate === 'type') row[10] = 99; else row[32] = null;
        const candidate: unknown[] = [];
        candidate[30] = [row];
        assert.deepEqual(decodeCandidateArtifacts(candidate).generatedFiles, []);
    }
});

test('mixed candidate[30] packets classify generated files and native documents in one pass', () => {
    const native: unknown[] = ['c_native_chat_report.md', null, '  Research notes  ', null, '# Unmodified body'];
    native[10] = 3;
    const foreign: unknown[] = ['c_other_chat_report.md', null, 'Foreign', null, '# Ignore'];
    foreign[10] = 3;
    const unsupported: unknown[] = ['c_native_chat_unknown', null, 'Other', null, '# Unknown'];
    unsupported[10] = 99;
    const candidate: unknown[] = ['rc_mixed', ['Mixed answer']];
    candidate[30] = [null, packet, native, foreign, unsupported, [26], { kind: 26 }];

    const decoded = decodeCandidateArtifacts(candidate, 'c_native_chat');
    assert.equal(decoded.generatedFiles.length, 1);
    const file = decoded.generatedFiles[0];
    assert.equal(file.id, packet[0]);
    assert.equal(file.name, packet[9]);
    assert.equal(file.fileName, packet[9]);
    assert.equal(new TextDecoder().decode(file.dataBuffer), (packet[32] as unknown[])[2]);
    assert.deepEqual(decoded.nativeDocuments, [{
        id: 'c_native_chat_report.md', title: 'Research notes', contentMarkdown: '# Unmodified body',
        type: 'file', sections: [], links: [], url: '', chipUrl: ''
    }]);

    // Generated packets have no conversation-id restriction; native documents do.
    assert.equal(decodeCandidateArtifacts(candidate).generatedFiles.length, 1);
    assert.deepEqual(decodeCandidateArtifacts(candidate).nativeDocuments, []);
    assert.deepEqual(decodeCandidateArtifacts(candidate, 'other_chat').nativeDocuments, [{
        id: 'c_other_chat_report.md', title: 'Foreign', contentMarkdown: '# Ignore',
        type: 'file', sections: [], links: [], url: '', chipUrl: ''
    }]);
});

test('missing or malformed candidate packet list yields empty classified artifacts', () => {
    const candidates: unknown[][] = [[], [null], Object.assign(Array(31).fill(null), { 30: 'wrong' })];
    for (const candidate of candidates) {
        assert.deepEqual(decodeCandidateArtifacts(candidate, 'native_chat'), {
            generatedFiles: [], nativeDocuments: []
        });
    }
});
