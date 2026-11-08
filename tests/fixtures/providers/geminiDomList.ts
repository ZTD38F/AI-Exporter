import { describeFixtures, synthetic } from './provenance.js';
/** DOM-facing Gemini List data (separate from the network RPC). */
const fixtureMap = {
    'G_LIST_SOURCE_BOUNDARY_11': () => {
        const header = { textContent: 'Header title' };
        const sidebar = { textContent: 'Google Gemini', href: 'https://gemini.google.com/app/boundary123',
            querySelector: () => null };
        const query = { textContent: 'First user question' };
        const doc = { title: 'Google Gemini',
            querySelectorAll: (selector: string) => selector.includes('a[href') ? [sidebar]
                : selector.includes('conversation-title') ? [header] : [],
            querySelector: (selector: string) => selector.startsWith('user-query') ? query : null,
        } as unknown as Document;
        return { header, doc };
    },
};
export function domListGen<K extends keyof typeof fixtureMap>(key: K): ReturnType<(typeof fixtureMap)[K]> {
    return fixtureMap[key]() as ReturnType<(typeof fixtureMap)[K]>;
}

export const fixtureOrigins = describeFixtures(fixtureMap, synthetic("Authored Gemini protocol, content or state counterexample; no saved capture is used."));
