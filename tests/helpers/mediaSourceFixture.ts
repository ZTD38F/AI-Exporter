import { fixtureAccount } from './domainFixture.js';
import { parseGeminiRpcConversation } from '../../src/l1/parsers/gemini/rpc/parseConversation.js';
import { detailGen as geminiDetailGen } from '../fixtures/providers/geminiDetail.js';
import { parseGeminiTakeoutArchive } from '../../src/l1/parsers/gemini/takeout/parseConversation.js';
import type { SourceConversationParseResult } from '../../src/l1/parsers/parsingResult.js';

export const mediaChatId = 'source-media';
export const mediaPrompt = 'Draw a diagram of a green bridge';
export const mediaTime = 1788350400000;
export const mediaBytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), c => c.charCodeAt(0));
const otherMediaBytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg+M/wHwAEAQH/cetH5QAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
function bytesFor(path: string) { return path.endsWith('/archive-0.png') ? mediaBytes : otherMediaBytes; }
export function mediaSources(options: { noTime?: boolean; noPrompt?: boolean; multi?: boolean; duplicate?: boolean } = {}) {
    const imageCount = options.multi ? 2 : 1;
    const key = options.noTime ? 'G_MEDIA_SOURCE_NO_TIME_01'
        : options.noPrompt ? 'G_MEDIA_SOURCE_NO_PROMPT_01'
            : options.multi ? 'G_MEDIA_SOURCE_MULTI_01' : 'G_MEDIA_SOURCE_DEFAULT_01';
    const online = parseGeminiRpcConversation(geminiDetailGen(key),
        { account: fixtureAccount('gemini'), providerId: 'gemini', targetConvId: mediaChatId });
    const activity = (prompt: string, time: number, answer: string, count?: number) =>
        `<div class="outer-cell"><a href="https://gemini.google.com/app/c_${mediaChatId}">Chat</a><div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Prompted ${prompt}<br>${new Date(time).toISOString()}<br>${answer}</div>${count ? `${count} generated image${count > 1 ? 's' : ''}` : ''}</div>`;
    let html = Array.from({ length: 6 }, (_, i) => activity(i === 5 ? mediaPrompt : `Takeout question ${i}`, mediaTime + (i === 5 ? 0 : (i - 20) * 1000),
        `<p>Takeout answer ${i}${i === 0 ? '<img src="previous.png">' : i === 5 ? Array.from({ length: imageCount }, (_, j) => `<img src="archive-${j}.png">`).join('') : ''}</p>`, i === 0 ? 1 : i === 5 ? imageCount : undefined)).join('');
    const files = Object.fromEntries(['previous.png', ...Array.from({ length: imageCount }, (_, i) => `archive-${i}.png`)].map(name => {
        const path = `Takeout/Gemini Apps/${name}`, bytes = bytesFor(path);
        return [path, { _data: { uncompressedSize: bytes.length }, async: async () => bytes.slice() }];
    }));
    if (options.duplicate) {
        html += activity(mediaPrompt, mediaTime, '<p><img src="duplicate.png"></p>', 1);
        files['Takeout/Gemini Apps/duplicate.png'] = { _data: { uncompressedSize: otherMediaBytes.length }, async: async () => otherMediaBytes.slice() };
    }
    const takeout = parseGeminiTakeoutArchive({ htmlText: html, archiveFiles: files, activityPath: 'Takeout/Gemini Apps/MyActivity.html' }, { account: fixtureAccount('gemini'), providerId: 'gemini' })[0];
    const offline: SourceConversationParseResult = takeout;
    const resources = Object.entries(takeout.archiveResources).map(([assetId, bound]) => ({ assetId, sourcePath: bound.path, bytes: bytesFor(bound.path).slice() }));
    online.conversation.detail.quality.status = 'complete';
    return { online, offline, files, resources };
}
