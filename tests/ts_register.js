const Module = require('module');
const esbuild = require('esbuild');
const fs = require('fs');
try { if (typeof globalThis !== 'undefined' && !globalThis.__EXT_VERSION__) globalThis.__EXT_VERSION__ = require('../package.json').version; } catch {}

// Register on-the-fly TypeScript compilation hook for Node.js CommonJS require
if (!require.extensions['.ts']) {
    require.extensions['.ts'] = function(module, filename) {
        const source = fs.readFileSync(filename, 'utf8');
        const result = esbuild.transformSync(source, {
            loader: 'ts',
            target: 'node20',
            format: 'cjs'
        });
        module._compile(result.code, filename);

        // Smart CJS Interop: bridge ESM default/named for require()
        // 纯 named 无 default 保留原 m；有 default 则将 named 挂到 default 并让 require 直接得到 default
        const m = module.exports;
        if (m && m.__esModule && m.default) {
            const def = m.default;
            if (def && (typeof def === 'function' || typeof def === 'object')) {
                for (const k of Object.keys(m)) {
                    if (k !== 'default' && k !== '__esModule' && !(k in def)) {
                        try { def[k] = m[k]; } catch (_) {}
                    }
                }
                if (!('default' in def)) { try { def.default = def; } catch (_) {} }
                try { def.__esModule = true; } catch (_) {}
                module.exports = def;
            }
        }
    };
}

// Intercept Module._resolveFilename so that require('./foo.js') resolves to './foo.ts'
// if foo.js was migrated to TypeScript.
const origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, isMain, options) {
    try {
        return origResolve.call(this, request, parent, isMain, options);
    } catch (err) {
        if (typeof request === 'string' && request.endsWith('.js')) {
            const tsReq = request.slice(0, -3) + '.ts';
            try {
                return origResolve.call(this, tsReq, parent, isMain, options);
            } catch (_) {}
        }
        throw err;
    }
};

// Intercept fs.readFileSync & fs.existsSync so that tests reading migrated .js files
// (e.g. fs.readFileSync('.../protocol.js', 'utf8') for vm.runInContext) seamlessly read and transpile the .ts file.
const origReadFileSync = fs.readFileSync;
fs.readFileSync = function(pathArg, options) {
    if (typeof pathArg === 'string' && pathArg.endsWith('.js')) {
        if (!origExistsSync.call(fs, pathArg)) {
            const tsPath = pathArg.slice(0, -3) + '.ts';
            if (origExistsSync.call(fs, tsPath)) {
                const source = origReadFileSync.call(fs, tsPath, 'utf8');
                // If it's protocol.js, hookCredentials.js, or bootstrap.js (which tests execute inside vm.runInContext), transpile it
                if (pathArg.endsWith('protocol.js') || pathArg.endsWith('hookCredentials.js') || pathArg.endsWith('bootstrap.js')) {
                    const isScript = pathArg.endsWith('bootstrap.js') || pathArg.endsWith('protocol.js') || pathArg.endsWith('hookCredentials.js');
                    const cleanSource = isScript
                        ? source
                            .replace(/import\s+(?:type\s+)?(?:\{[^}]*\}|[\w*\s,]+)\s*from\s*['"][^'"]+['"];?\s*/g, '')
                            .replace(/import\s+['"][^'"]+['"];?\s*/g, '')
                            .replace(/export\s*\{[^}]*\};?\s*/g, '')
                            .replace(/export\s+default\s+[^;]+;?\s*/g, '')
                        : source;
                    const format = isScript ? 'iife' : undefined;
                    const globalName = pathArg.endsWith('protocol.js') ? 'GeminiProtocol' : undefined;
                    const result = esbuild.transformSync(cleanSource, {
                        loader: 'ts',
                        target: 'chrome120',
                        format,
                        globalName,
                        charset: 'utf8'
                    });
                    let code = result.code;
                    if (pathArg.endsWith('protocol.js')) {
                        code += "\nif (typeof GeminiProtocol !== 'undefined') { if (typeof globalThis !== 'undefined') globalThis.GeminiProtocol = GeminiProtocol; if (typeof window !== 'undefined') window.GeminiProtocol = GeminiProtocol; }";
                    }
                    const encoding = typeof options === 'string' ? options : (options && options.encoding);
                    if (encoding) {
                        return code;
                    }
                    return Buffer.from(code, 'utf8');
                }
                // For other files where tests perform source-level code assertions, return raw source
                const encoding = typeof options === 'string' ? options : (options && options.encoding);
                if (encoding) {
                    return source;
                }
                return Buffer.from(source, 'utf8');
            }
        }
    }
    return origReadFileSync.apply(fs, arguments);
};

const origExistsSync = fs.existsSync;
fs.existsSync = function(pathArg) {
    if (typeof pathArg === 'string' && pathArg.endsWith('.js')) {
        if (origExistsSync.call(fs, pathArg)) {
            return true;
        }
        const tsPath = pathArg.slice(0, -3) + '.ts';
        return origExistsSync.call(fs, tsPath);
    }
    return origExistsSync.call(fs, pathArg);
};

