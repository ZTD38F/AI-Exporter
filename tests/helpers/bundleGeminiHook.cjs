const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');

// Bundle the real transport/router/handlers together, like the extension build.
// Only account discovery is supplied by each sandbox's browser fixture.
module.exports = function bundleGeminiHook() {
    const filename = path.resolve('src/l1/sniffer/gemini/hookCredentials.ts');
    const contents = fs.readFileSync(filename, 'utf8')
        .replace(/^import \{ (?:sniffUserProfileFromDom|geminiAccountObservation) \} from [^\n]+\n/gm, '');
    return buildSync({ stdin: { contents, loader: 'ts', resolveDir: path.dirname(filename) },
        bundle: true, format: 'iife', target: 'chrome120', write: false,
        logOverride: { 'commonjs-variable-in-esm': 'silent' },
    }).outputFiles[0].text;
};
