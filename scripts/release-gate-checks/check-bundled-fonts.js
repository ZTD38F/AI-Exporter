#!/usr/bin/env node
/** Verify the exact licensed offline font fallback; reject extra or embedded fonts. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const SCAN_ROOTS = ['dist', 'src', 'lib', 'icons', '_locales'];
const FONT_EXTS = new Set(['.ttf', '.otf', '.ttc', '.otc', '.woff', '.woff2', '.eot']);
const FONT_DIR = 'src/l4/format/pdf/sandbox/fonts/';
const TOTAL_FONT_BUDGET_BYTES = 22 * 1024 * 1024;
const APPROVED_FONTS = [
    { file: 'DejaVuSansMono.ttf', sha256: '602ec86b8948cfcd956482fe64f94c36c867770149ef2f791d4613f443bcecb3',
      license: 'LICENSE-DejaVu.txt', licenseSha256: 'd75938dec098f06f0ac3c00853065d94f020be1c3c62ef1dc2975ba15b4d9b0e' },
    { file: 'NotoEmoji-Variable.ttf', sha256: 'de6c18832938afc99caf132b39d6a30a19bac7f2e812e28db2535b4608d27551',
      license: 'OFL-NotoEmoji.txt', licenseSha256: '500bb1ccf43df7bbb522112f9133a52b16e1c35e809632f5d8609b179152de5b' },
    { file: 'NewCMMath-Regular.otf', sha256: '5e82df214f99cc7057e8236f3dab06f8fac95a23ddc2f0fd41ddeb2f38ea72fe',
      license: 'GUST-FONT-LICENSE.txt', licenseSha256: '49ea6cb9257bbee0a3979c48a774cd221550ac1c20c95549efe45fc99cc18050' },
    { file: 'NotoSansCJKsc-Regular.otf', sha256: '2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b',
      license: 'OFL-NotoSansCJK.txt', licenseSha256: '6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2' },
    { file: 'NotoSansMono-Variable.ttf', sha256: '2cb2adb378a8f574213e23df697050b83c54c27df465a2015552740b2769a081',
      license: 'OFL-NotoSansMono.txt', licenseSha256: 'cee9892f9f0cc8fe882c9e9537ee6a89621d86ee7ceaf70b02e2b2b1c25c061a' },
];
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function checkBundledFonts(root = ROOT) {
    const failures = [], fontFiles = [], embeddedFontFiles = [];
    let totalBytes = 0;
    const approvedPaths = new Set(APPROVED_FONTS.map(font => FONT_DIR + font.file));
    function walk(dir) {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === '.git') continue;
            const full = path.join(dir, entry.name);
            const relative = path.relative(root, full).split(path.sep).join('/');
            if (entry.isSymbolicLink()) {
                failures.push(`Symlink in shipped assets: ${relative}`);
            } else if (entry.isDirectory()) walk(full);
            else if (entry.isFile()) {
                if (FONT_EXTS.has(path.extname(entry.name).toLowerCase())) {
                    fontFiles.push(relative);
                    totalBytes += fs.statSync(full).size;
                    if (!approvedPaths.has(relative)) failures.push(`Unapproved font: ${relative}`);
                }
                if (relative.startsWith('dist/') && /\.js$/.test(relative)
                    && /data:font\/[a-z0-9.+-]+;base64,/i.test(fs.readFileSync(full, 'utf8'))) {
                    embeddedFontFiles.push(relative);
                    failures.push(`Embedded data:font/ URI: ${relative}`);
                }
            }
        }
    }
    for (const dir of SCAN_ROOTS) walk(path.join(root, dir));
    for (const font of APPROVED_FONTS) {
        for (const [name, expected] of [[font.file, font.sha256], [font.license, font.licenseSha256]]) {
            const relative = FONT_DIR + name;
            const file = path.join(root, relative);
            if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) failures.push(`Missing approved asset: ${relative}`);
            else if (hash(file) !== expected) failures.push(`SHA256 mismatch: ${relative}`);
        }
    }
    if (totalBytes > TOTAL_FONT_BUDGET_BYTES) failures.push(`Font budget exceeded: ${totalBytes} > ${TOTAL_FONT_BUDGET_BYTES} bytes`);
    return { failures, fontFiles, embeddedFontFiles, totalBytes };
}

module.exports = { checkBundledFonts };
if (require.main === module) {
    const result = checkBundledFonts();
    console.log(`[release-gate] approved offline fonts: ${result.fontFiles.length}, ${result.totalBytes} bytes (budget ${TOTAL_FONT_BUDGET_BYTES})`);
    if (result.failures.length) {
        result.failures.forEach(failure => console.error(`  FAIL: ${failure}`));
        process.exitCode = 1;
    } else console.log('[release-gate] PASS: exact approved font/license hashes; no extra or embedded fonts');
}
