// build.js — esbuild pure bundle build pipeline for Gemini Exporter.
//
// Modern Architecture (Pure Bundle Pipeline):
// Directly builds the 5 self-contained production IIFE bundles loaded by Chrome MV3:
//   1. content/content    -> dist/content/content.js   (ISOLATED world content script)
//   2. content/hook       -> dist/content/hook.js      (MAIN world network interceptor)
//   3. background/background -> dist/background/background.js (Service Worker bundle)
//   4. ui/popup          -> dist/ui/popup.js          (Popup modal coordinator)
//   5. ui/options        -> dist/ui/options.js        (Options workbench coordinator)
//
// Optional:
// Pass `--per-file` to additionally generate individual unbundled modules for offline inspection.

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const PKG_VERSION = (() => {
    try {
        return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '1.5.0';
    } catch {
        return '1.5.0';
    }
})();
const DEFINE_VERSION = { __EXT_VERSION__: JSON.stringify(PKG_VERSION) };

const BUNDLE_ENTRIES = {
    'content/content': path.join(SRC, 'content', 'content.ts'),
    'content/hook': path.join(SRC, 'content', 'hookCredentials.ts'),
    'background/background': path.join(SRC, 'background', 'background.ts'),
    'ui/popup': path.join(SRC, 'ui', 'popup', 'popup.ts'),
    'ui/options': path.join(SRC, 'ui', 'options', 'options.ts'),
};

const EXPECTED_BUNDLES = [
    'dist/content/content.js',
    'dist/content/hook.js',
    'dist/background/background.js',
    'dist/ui/popup.js',
    'dist/ui/options.js',
];

function walkSourceFiles(dir) {
    const out = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const tsBases = new Set();
    for (const entry of entries) {
        if (!entry.isDirectory() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
            tsBases.add(entry.name.slice(0, -3));
        }
    }

    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'types') continue;
            out.push(...walkSourceFiles(full));
        } else if (entry.name.endsWith('.d.ts')) {
            continue;
        } else if (entry.name.endsWith('.ts')) {
            out.push(full);
        } else if (entry.name.endsWith('.js')) {
            const base = entry.name.slice(0, -3);
            if (!tsBases.has(base)) out.push(full);
        }
    }
    return out;
}

async function build() {
    const t0 = Date.now();
    if (!fs.existsSync(SRC)) {
        throw new Error('src/ directory not found');
    }

    // Clean dist to ensure zero stale files
    fs.rmSync(DIST, { recursive: true, force: true });

    // Validate that all 5 bundle entrypoint source files exist
    for (const [entryName, entryFile] of Object.entries(BUNDLE_ENTRIES)) {
        if (!fs.existsSync(entryFile)) {
            throw new Error(`Bundle entrypoint source missing for ${entryName}: ${entryFile}`);
        }
    }

    // 1. Build all 5 production IIFE bundles in parallel
    const bundleResult = await esbuild.build({
        entryPoints: BUNDLE_ENTRIES,
        outdir: DIST,
        bundle: true,
        format: 'iife',
        minify: true,
        sourcemap: false,
        target: ['chrome120'],
        legalComments: 'none',
        define: DEFINE_VERSION,
        logLevel: 'silent',
        logOverride: {
            'commonjs-variable-in-esm': 'silent'
        },
        write: true,
    });

    const warnings = (bundleResult.warnings || []).length;
    const errors = (bundleResult.errors || []).length;
    if (errors > 0) {
        throw new Error(`esbuild bundle build failed with ${errors} error(s)`);
    }

    // 2. Optional: Per-file transform when explicitly requested via --per-file
    if (process.argv.includes('--per-file')) {
        const perFileEntries = walkSourceFiles(SRC);
        const perFileResult = await esbuild.build({
            entryPoints: perFileEntries,
            outdir: DIST,
            outbase: SRC,
            bundle: false,
            minify: true,
            sourcemap: true,
            target: ['chrome120'],
            legalComments: 'none',
            define: DEFINE_VERSION,
            logLevel: 'silent',
            write: true,
        });
        if ((perFileResult.errors || []).length > 0) {
            throw new Error(`esbuild per-file build failed with ${perFileResult.errors.length} error(s)`);
        }
    }

    // 3. Verify all expected production bundles exist
    for (const bundle of EXPECTED_BUNDLES) {
        const fullPath = path.join(ROOT, bundle);
        if (!fs.existsSync(fullPath)) {
            throw new Error(`missing dist bundle artifact for ${bundle}`);
        }
    }

    const jsFiles = [];
    (function collect(dir) {
        if (!fs.existsSync(dir)) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) collect(full);
            else if (e.name.endsWith('.js')) jsFiles.push(full);
        }
    })(DIST);

    console.log(`[build] ${jsFiles.length} JS bundle(s) -> dist/ in ${Date.now() - t0}ms (${warnings} warning(s))`);
}

build().catch((err) => {
    console.error('[build] FAILED:', err.message || err);
    process.exit(1);
});
