import { buildSync } from 'esbuild';
import * as path from 'node:path';

declare global {
    var fixtureAccount: typeof import('../helpers/domainFixture.js').fixtureAccount;
    var fixtureKey: typeof import('../helpers/domainFixture.js').fixtureKey;
    var fixtureAccountFor: typeof import('../helpers/domainFixture.js').fixtureAccountFor;
}

/** Browser evaluations cannot close over Node imports; install fixture builders explicitly. */
export const domainFixtureBrowser = buildSync({
    stdin: { contents: `import { fixtureAccount, fixtureKey, fixtureAccountFor } from './tests/helpers/domainFixture.ts';
        Object.assign(globalThis, { fixtureAccount, fixtureKey, fixtureAccountFor });`,
        resolveDir: path.resolve(__dirname, '../..'), loader: 'ts' },
    bundle: true, write: false, platform: 'browser', format: 'iife',
}).outputFiles[0].text;
