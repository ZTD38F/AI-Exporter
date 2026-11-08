import { describeFixtures, synthetic } from './provenance.js';
/** Bytes from the signed URL returned by GET /backend-api/files/download/:id.
 * This is a distinct remote response, not the ChatGPT download-metadata JSON.
 */
const fixtureMap = {
    'C_SIGNED_ASSET_CAT_PNG_01': () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
};

export function signedAssetGen(key: keyof typeof fixtureMap): Uint8Array<ArrayBuffer> {
    return fixtureMap[key]();
}

export const fixtureOrigins = describeFixtures(fixtureMap, synthetic("Authored ChatGPT protocol, content or state counterexample; no saved capture is used."));
