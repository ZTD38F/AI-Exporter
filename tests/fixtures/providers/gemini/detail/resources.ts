import { rpc, boundaryTurn } from './protocol.js';
import { citationFile } from './sources.js';

/** Raw source-turn fixture for generated file-chip placement and UTF-8 resource checks. */
export function generatedFileTurn(packet: unknown[], chip: unknown[], content: string, id: string, document: boolean): unknown[] {
    const candidate: unknown[] = ['rc_' + id, [content], 'en'];
    const payload: unknown[] = [[candidate]];
    if (document) {
        candidate[30] = [packet];
        payload[12] = [[[ [null, [null, 0, 'Before']], chip, [null, [null, 0, 'After']] ]]];
    }
    return [['r_' + id, 'c_e6dc4e0732ba568b'], [1700000000, 0], [['Prompt']], payload];
}

/** Raw Gemini image-evidence Detail responses (search metadata must not become assets). */
export function visibleImageResponse(document?: unknown, includeSecondary = false): string {
    const searchUrl = 'https://encrypted-tbn2.gstatic.com/licensed-image?q=example';
    const searchResult = [
        [[searchUrl], null, 2048, 1536, null, null, null, 0, 'getty:example', 'getty', 'Getty Images'],
        [['https://www.gettyimages.com/detail/example'], '', 8], null,
        [[searchUrl], null, 2048, 1536, null, null, null, 0], null, null, null,
        ['http://googleusercontent.com/image_agent_tag_example', null, 'Reference diagram', null, null, 1],
    ];
    const candidate: unknown[] = ['rc_visible_images_test', ['Answer without pictures'], 'en'];
    candidate[12] = [searchResult];
    const candidates: unknown[] = [candidate];
    if (includeSecondary) {
        const secondary: unknown[] = ['rc_secondary_images_test', ['Second answer without pictures'], 'en'];
        secondary[12] = [searchResult];
        candidates.push(secondary);
    }
    const model: unknown[] = [candidates];
    if (document) model[12] = document;
    const turn = [['c_visible_images_test'], [1700000000, 0], [['Question']], model];
    return ")]}'\n\n" + JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify([[turn]])]]);
}

export const visibleImageDocument = (): unknown =>
    citationFile('wire-turn-3-12-b-stack');

export function mixedNativeDocument(kind: number, body: string, more = false, suffix = 'report.md', metadata = true): string {
    const row: unknown[] = ['c_native_chat_' + suffix, null, 'Source document', null, body];
    row[10] = kind;
    if (metadata) row[8] = [['Metadata that must never become document prose'.repeat(5)]];
    const candidate: unknown[] = ['rc_native', ['Answer before document']];
    candidate[30] = [row];
    const turn = [['c_native_chat', 'r_native'], null, [['Question']], [[candidate]], [1700000010, 0]];
    return JSON.stringify([
        ['wrb.fr', 'hNvQHb', JSON.stringify([[turn], more ? 'next' : null, null, []])],
        ['wrb.fr', 'MaZiqc', JSON.stringify([null, null,
            [['c_native_chat', 'Title', null, null, null, [1700000000, 0]]]])],
    ]);
}

/** The image-bearing hNvQHb source used by Takeout/media-identity integration tests. */
export function mediaOnlineDetail(missingTime = false, missingPrompt = false, multipleImages = false): string {
    const time = 1788350400000, prompt = 'Draw a diagram of a green bridge';
    const pngLength = 68;
    const images = Array.from({ length: multipleImages ? 2 : 1 }, (_, i) => {
        const image: unknown[] = Array(16).fill(null);
        image[2] = 'online-' + i + '.png';
        image[3] = 'https://lh3.googleusercontent.com/media-source-' + i;
        image[11] = 'image/png';
        image[15] = [1, 1, pngLength];
        return image;
    });
    const turns = Array.from({ length: 10 }, (_, i) => [
        ['c_source-media', 'r_request-' + i],
        missingTime && i === 9 ? null : [time / 1000 + (i === 9 ? 0 : i - 20), 123000000],
        missingPrompt && i === 9 ? null : [[i === 9 ? prompt : 'Online question ' + i]],
        [['rc_answer-' + i, [['Complete online answer ' + i], ...(i === 9 ? images : [])]]],
    ]);
    return ")]}'\n\n" + JSON.stringify([['wrb.fr', 'hNvQHb',
        JSON.stringify([turns, null, 'Complete online body'])]]);
}

export function boundaryImageAttachmentWire(): string {
    const url = 'https://lh3.googleusercontent.com/boundary-image';
    const image = [url, 640, 480, 'boundary-token'];
    return rpc([[boundaryTurn('Look at the image', null, [
        ['rc_image', [['![Image](' + url + ')'], image, null, ['broken.png']]],
    ])]]);
}
