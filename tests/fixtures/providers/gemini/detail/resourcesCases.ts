import { describeFixtures, synthetic, derived } from '../../provenance.js';
import { emptyTurnWire } from './protocol.js';
import { generatedFileTurn, visibleImageResponse, visibleImageDocument, mixedNativeDocument, mediaOnlineDetail, boundaryImageAttachmentWire } from './resources.js';
import { generatedFile } from '../sources.js';

export const resourcesCases = {
    'G_BOUNDARY_IMAGE_ATTACHMENT_01': () => boundaryImageAttachmentWire(),
    'G_MEDIA_SOURCE_DEFAULT_01': () => mediaOnlineDetail(),
    'G_MEDIA_SOURCE_NO_TIME_01': () => mediaOnlineDetail(true),
    'G_MEDIA_SOURCE_NO_PROMPT_01': () => mediaOnlineDetail(false, true),
    'G_MEDIA_SOURCE_MULTI_01': () => mediaOnlineDetail(false, false, true),
    'G_NATIVE_DOCUMENT_01': () => mixedNativeDocument(1, '# Report\n\nExact source body'),
    'G_NATIVE_DOCUMENT_02': () => mixedNativeDocument(1, '# Report\n\nExact source body', true),
    'G_NATIVE_DOCUMENT_03': () => mixedNativeDocument(2, "```python\nprint(\"ok\")\n```"),
    'G_NATIVE_DOCUMENT_04': () => mixedNativeDocument(2, "```python\nprint(\"ok\")\n```", true),
    'G_NATIVE_DOCUMENT_05': () => mixedNativeDocument(3, '# Research\n\nReferences and findings'),
    'G_NATIVE_DOCUMENT_06': () => mixedNativeDocument(3, '# Research\n\nReferences and findings', true),
    'G_NATIVE_DOCUMENT_07': () => mixedNativeDocument(3, 'First body', false, 'first', false),
    'G_NATIVE_DOCUMENT_08': () => mixedNativeDocument(3, 'Second body', false, 'second', false),
    'G_VISIBLE_IMAGE_01': () => visibleImageResponse(),
    'G_VISIBLE_IMAGE_02': () => visibleImageResponse(),
    'G_VISIBLE_IMAGE_03': () => visibleImageResponse(visibleImageDocument()),
    'G_VISIBLE_IMAGE_04': () => visibleImageResponse(visibleImageDocument(), true),
    'G_GENERATED_FILES_01': () => {
        const fixture = structuredClone(generatedFile) as { packet: unknown[]; chip: unknown[] };
        return JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify([[
            generatedFileTurn(fixture.packet, fixture.chip, 'Before\n\nAfter', 'later', true),
            generatedFileTurn(fixture.packet, fixture.chip, 'Earlier caption', 'earlier', false),
        ]])]]);
    },
    'G_PAGINATION_EMPTY_DOCUMENT': () => emptyTurnWire('c_source_chat_123', true),
};

const wireTurn312BStackOrigin = derived(["tests/fixtures/provider/structured_rpc/wire-turn-3-12-b-stack.json"], "Saved Detail/structured content or measured timestamps with authored identity, RPC framing or boundary mutations.");

export const fixtureOrigins = describeFixtures(resourcesCases, synthetic("Authored Gemini protocol, content or state counterexample; no saved capture is used."), {
    G_VISIBLE_IMAGE_03: wireTurn312BStackOrigin,
    G_VISIBLE_IMAGE_04: wireTurn312BStackOrigin,
    G_GENERATED_FILES_01: derived(["tests/fixtures/provider/gemini_generated_file.json"], "Saved Detail/structured content or measured timestamps with authored identity, RPC framing or boundary mutations."),
});
