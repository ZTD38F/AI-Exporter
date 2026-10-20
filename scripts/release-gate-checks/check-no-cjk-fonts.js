#!/usr/bin/env node
/**
 * Release gate: ensures full CJK fonts (~16 MB each) are never bundled into the
 * extension package (either as font files or base64 data:font/ URIs); CJK rendering
 * relies on Local Font Access at runtime.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SCAN_ROOTS = ['dist', 'src', 'lib', 'icons', '_locales'];

const FONT_EXTS = new Set(['.ttf', '.otf', '.ttc', '.otc', '.woff', '.woff2', '.eot']);

const CJK_NAME_PATTERNS = [
    /cjk/i,
    /hansans/i, /sourcehan/i,
    /noto.*(sans|serif).*(sc|tc|jp|kr|hk)/i,
    /wqy/i,
    /uming/i, /ukai/i, /zenhei/i,
    /hanazono/i,
    /pingfang/i, /songti/i, /kaiti/i, /heiti/i, /fangsong/i, /lishu/i,
    /xingkai/i, /weibei/i,
    /stheiti/i, /stsong/i, /stkaiti/i, /stfangsong/i, /stxihei/i, /stzhongsong/i,
    /simsun/i, /simhei/i, /simkai/i, /simfang/i, /simli/i, /simyou/i,
    /yahei/i, /dengxian/i,
    /meiryo/i, /msgothic/i, /msmincho/i, /yumin/i, /yugothic/i,
    /malgun/i, /gulim/i, /batang/i, /dotum/i,
    /hanzipen/i,
    /sarasa/i, /lxgw/i,
    /misans/i,
    /arphic/i, /cwtex/i,
    /dfkai/i, /mingliu/i, /pmingliu/i,
    /adobe(fan|song|hei|kai|fangsong)/i,
];

const TOTAL_FONT_BUDGET_BYTES = 5 * 1024 * 1024;

function walkFonts(dir, out) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name === 'node_modules' || e.name === '.git') continue;
            walkFonts(full, out);
        } else if (e.isFile() && FONT_EXTS.has(path.extname(e.name).toLowerCase())) {
            out.push(full);
        }
    }
}

function humanBytes(n) {
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
}

function main() {
    console.log('[release-gate] check-no-cjk-fonts');
    console.log(`  scan roots: ${SCAN_ROOTS.join(', ')}`);

    const fontFiles = [];
    for (const root of SCAN_ROOTS) walkFonts(path.join(ROOT, root), fontFiles);

    let totalBytes = 0;
    const cjkHits = [];
    for (const f of fontFiles) {
        const size = fs.statSync(f).size;
        totalBytes += size;
        const base = path.basename(f);
        if (CJK_NAME_PATTERNS.some(re => re.test(base))) {
            cjkHits.push({ file: path.relative(ROOT, f), size });
        }
    }

    const embeddedFontHits = [];
    const distDir = path.join(ROOT, 'dist');
    if (fs.existsSync(distDir)) {
        const jsFiles = [];
        const collectJs = dir => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) collectJs(full);
                else if (e.isFile() && full.endsWith('.js')) jsFiles.push(full);
            }
        };
        collectJs(distDir);
        for (const jf of jsFiles) {
            const content = fs.readFileSync(jf, 'utf8');
            const matches = content.match(/data:font\/[a-z0-9.+-]+;base64,/gi) || [];
            if (matches.length > 0) {
                embeddedFontHits.push({ file: path.relative(ROOT, jf), count: matches.length });
            }
        }
    }

    console.log(`  font files found: ${fontFiles.length} (${humanBytes(totalBytes)})`);
    for (const f of fontFiles) {
        console.log(`    - ${path.relative(ROOT, f)} (${humanBytes(fs.statSync(f).size)})`);
    }

    const failures = [];
    if (cjkHits.length > 0) {
        failures.push(
            `CJK font file(s) bundled (${cjkHits.length}):\n` +
            cjkHits.map(h => `    - ${h.file} (${humanBytes(h.size)})`).join('\n'),
        );
    }
    if (totalBytes >= TOTAL_FONT_BUDGET_BYTES) {
        failures.push(
            `total bundled font size ${humanBytes(totalBytes)} >= budget ${humanBytes(TOTAL_FONT_BUDGET_BYTES)} ` +
            `(a full CJK font is ~16.4MB; suspected renamed CJK font)`,
        );
    }
    if (embeddedFontHits.length > 0) {
        failures.push(
            `embedded data:font/ URI(s) in dist JS (fonts must ship as files to stay auditable):\n` +
            embeddedFontHits.map(h => `    - ${h.file} (${h.count} occurrence(s))`).join('\n'),
        );
    }

    if (failures.length > 0) {
        console.error('\n[release-gate] FAIL: CJK fonts must not ship with the extension package.\n');
        for (const f of failures) console.error(`  ${f}\n`);
        console.error('  P0 policy: CJK via Local Font Access (local-first), never bundled. See P0 formal REPORT §4.');
        process.exit(1);
    }

    console.log(
        `  PASS: no CJK fonts bundled; total font size ${humanBytes(totalBytes)} ` +
        `< ${humanBytes(TOTAL_FONT_BUDGET_BYTES)} budget; no embedded data:font/ URIs`,
    );
}

main();
