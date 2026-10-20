// scripts/release-prepare.js — one-time release housekeeping, kept OUT of the build.
//
// Syncs package.json "version" and the README version badges from manifest.json
// (the version Single Source of Truth). This used to run inside build.js on every
// build; it was moved here so that `node build.js` is pure and never mutates the
// tracked source tree.
//
// Usage: npm run release:prepare

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'manifest.json');
const PKG_PATH = path.join(ROOT, 'package.json');

const EXT_VERSION = (() => {
    try {
        const parsed = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
        if (!parsed.version) {
            throw new Error('manifest.json does not contain a "version" property');
        }
        return parsed.version;
    } catch (err) {
        console.error('[release:prepare] Failed to read version from manifest.json:', err.message);
        process.exit(1);
    }
})();

// Keep package.json version in sync with manifest.json (Single Source of Truth)
try {
    if (fs.existsSync(PKG_PATH)) {
        const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
        if (pkg.version !== EXT_VERSION) {
            pkg.version = EXT_VERSION;
            fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
            console.log(`[release:prepare] Synced package.json version to manifest.json (${EXT_VERSION})`);
        }
    }
} catch (err) {
    console.warn('[release:prepare] Warning: Could not sync package.json version:', err.message);
}

// Keep README version badges in sync with manifest.json
for (const readmeFile of ['README.md', 'README_zh.md']) {
    const readmePath = path.join(ROOT, readmeFile);
    if (fs.existsSync(readmePath)) {
        try {
            const content = fs.readFileSync(readmePath, 'utf8');
            const updated = content
                .replace(/(https:\/\/img\.shields\.io\/badge\/(?:%E7%89%88%E6%9C%AC|Version)-)[0-9.]+(-orange\.svg\?style=for-the-badge)/g, `$1${EXT_VERSION}$2`)
                .replace(/(alt="(?:版本|Version): )[0-9.]+(")/g, `$1${EXT_VERSION}$2`);
            if (updated !== content) {
                fs.writeFileSync(readmePath, updated);
                console.log(`[release:prepare] Synced ${readmeFile} version badge to ${EXT_VERSION}`);
            }
        } catch (err) {
            console.warn(`[release:prepare] Warning: Could not sync ${readmeFile} badge:`, err.message);
        }
    }
}

console.log(`[release:prepare] Done (version ${EXT_VERSION})`);
