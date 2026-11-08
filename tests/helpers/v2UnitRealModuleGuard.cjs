'use strict';
/**
 * Strict runtime guard for the independently owned v2 module-unit suites.
 * Compile only the owner module's production code; any real implementation
 * from another owner fails immediately. Type-only dependencies are erased by
 * the TypeScript loader; contract-shaped mock exports supplied by a test
 * harness never invoke Module#_compile.
 *
 * Shared is the repository's pure common foundation, not a business module.
 * Integration tests are deliberately excluded and remain separately runnable.
 */
const Module = require('node:module');
const path = require('node:path');

const owners = new Set(['l1', 'l2', 'l3a', 'l3b', 'l4', 'application', 'runtime', 'ui', 'migration', 'shared']);
const owner = process.env.V2_UNIT_OWNER;
if (!owner || !owners.has(owner)) {
    throw new Error('Set V2_UNIT_OWNER to an explicit v2 module when enabling the strict unit guard');
}
const sourceRoot = path.resolve(__dirname, '../../src');
const originalCompile = Module.prototype._compile;
Module.prototype._compile = function(code, filename) {
    const relative = path.relative(sourceRoot, filename).replace(/\\/g, '/');
    if (relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative)) {
        const sourceOwner = relative.split('/')[0];
        if (owners.has(sourceOwner) && sourceOwner !== owner && sourceOwner !== 'shared') {
            throw new Error(
                'Unit isolation violation: ' + owner + ' compiled real ' + sourceOwner +
                ' implementation: src/' + relative +
                '. Inject a mock of the v2 definition or move this suite to integration.'
            );
        }
    }
    return originalCompile.call(this, code, filename);
};
