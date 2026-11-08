import { versionCases } from './gemini/detail/versionCases.js';
import { protocolCases } from './gemini/detail/protocolCases.js';
import { contentCases } from './gemini/detail/contentCases.js';
import { resourcesCases } from './gemini/detail/resourcesCases.js';
import { integrationCases } from './gemini/detail/integrationCases.js';

const fixtureMap = {
    ...versionCases,
    ...protocolCases,
    ...contentCases,
    ...resourcesCases,
    ...integrationCases,
};

export function detailGen(key: keyof typeof fixtureMap): string {
    return fixtureMap[key]();
}
