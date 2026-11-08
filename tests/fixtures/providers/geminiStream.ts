import { describeFixtures, synthetic, derived } from './provenance.js';
import streamFrames from '../gemini_answered_stream.json';

/** Native StreamGenerate response bodies, one immutable key per test wire variant. */
function streamWire(answered = 2, responseId = 'r_abc123'): string {
    // Derive status/request variations from the saved native frame, not a parallel schema.
    const rows: unknown[][] = structuredClone(streamFrames.frames[0]);
    const inner = JSON.parse(String(rows[0][2])) as unknown[];
    (inner[1] as string[])[1] = responseId;
    ((inner[4] as unknown[][])[0])[8] = [answered];
    rows[0][2] = JSON.stringify(inner);
    const frame = JSON.stringify(rows);
    return ")]}'\n\n" + Buffer.byteLength(frame) + '\n' + frame + '\n';
}
function inclusiveWire(): string {
    return streamWire().replace(/\n(\d+)\n/, (_match, count) => '\n' + (Number(count) + 2) + '\n');
}
function capturedStream(): string {
    const fixture: { frames: unknown[] } = streamFrames;
    return ")]}'\n\n" + fixture.frames.map(frame => {
        const json = JSON.stringify(frame);
        return (Buffer.byteLength(json) + 2) + '\n\n' + json + '\n';
    }).join('');
}
function capturedE2eStream(): string {
    const fixture: { frames: unknown[] } = streamFrames;
    const json = JSON.stringify(fixture.frames[0]);
    return ")]}'\n\n" + (json.length + 2) + '\n' + json + '\n';
}
function unicodeStream(): string {
    const inner = [null, ['c_abcdef123456', 'r_abc123'], null, null,
        [['rc_abc123', ['公式：α + β，中文与 🌿'], null, null, null, null, null, null, [2]]]];
    const frame = JSON.stringify([['wrb.fr', null, JSON.stringify(inner)]]);
    return ")]}'\n\n" + (frame.length + 2) + '\n\n' + frame + '\n';
}
function largeCumulativeStream(): string {
    const progress = streamWire(1).replace('sanitized reply', 'x'.repeat(8192));
    const line = progress.split('\n').find(value => value.startsWith('[['));
    if (!line) throw new Error('Missing Gemini stream progress frame');
    return ")]}'\n\n" + ((line.length + 2) + '\n' + line + '\n').repeat(480)
        + streamWire().split('\n').slice(2).join('\n');
}
const fixtureMap = {
    'G_STREAM_EMPTY_HTTP_01': () => '',
    'G_STREAM_ANSWERED_01': () => streamWire(),
    'G_STREAM_UNANSWERED_01': () => streamWire(1),
    'G_STREAM_DIFFERENT_REQUEST_01': () => streamWire(2, 'r_def456'),
    'G_STREAM_INVALID_EMPTY_01': () => '[]\n',
    'G_STREAM_EXTRA_LENGTH_01': () => streamWire() + '50\n',
    'G_STREAM_ERROR_TRAILER_01': () => streamWire() + '[["er",7]]\n',
    'G_STREAM_OVER_101_MIB_01': () => streamWire() + ' '.repeat(101 * 1024 * 1024),
    'G_STREAM_INCLUSIVE_01': () => inclusiveWire(),
    'G_STREAM_CORRUPT_LENGTH_01': () => inclusiveWire().replace(/\n(\d+)\n/,
        (_match, count) => '\n' + (Number(count) + 1) + '\n'),
    'G_STREAM_CAPTURED_ANSWERED_01': () => capturedStream(),
    'G_STREAM_UNICODE_INCLUSIVE_01': () => unicodeStream(),
    'G_STREAM_CUMULATIVE_3_MIB_01': () => largeCumulativeStream(),
    'G_STREAM_E2E_ANSWERED_01': () => capturedE2eStream(),
};

export function streamGen(key: keyof typeof fixtureMap): string {
    return fixtureMap[key]();
}

const geminiAnsweredStreamOrigin = derived(["tests/fixtures/gemini_answered_stream.json"], "Saved decoded Stream frames rewrapped with explicit status, identity, framing or stress mutations.");

export const fixtureOrigins = describeFixtures(fixtureMap, synthetic("Authored Gemini protocol, content or state counterexample; no saved capture is used."), {
    G_STREAM_ANSWERED_01: geminiAnsweredStreamOrigin,
    G_STREAM_UNANSWERED_01: geminiAnsweredStreamOrigin,
    G_STREAM_DIFFERENT_REQUEST_01: geminiAnsweredStreamOrigin,
    G_STREAM_EXTRA_LENGTH_01: geminiAnsweredStreamOrigin,
    G_STREAM_ERROR_TRAILER_01: geminiAnsweredStreamOrigin,
    G_STREAM_OVER_101_MIB_01: geminiAnsweredStreamOrigin,
    G_STREAM_INCLUSIVE_01: geminiAnsweredStreamOrigin,
    G_STREAM_CORRUPT_LENGTH_01: geminiAnsweredStreamOrigin,
    G_STREAM_CAPTURED_ANSWERED_01: geminiAnsweredStreamOrigin,
    G_STREAM_CUMULATIVE_3_MIB_01: geminiAnsweredStreamOrigin,
    G_STREAM_E2E_ANSWERED_01: geminiAnsweredStreamOrigin,
});
