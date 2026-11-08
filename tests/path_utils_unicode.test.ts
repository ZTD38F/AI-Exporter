import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExportFileName, sanitizeFileName, sanitizeRelativePath } from '../src/shared/utils/pathUtils.js';

test('export filenames remove Unicode noncharacters from diagnostic titles', () => {
    assert.equal(buildExportFileName('确认Amazon余额充值 \u{5FFFF}', '6ae0497e-40d0-83e8-80f5-544b41748b97'),
        '确认Amazon余额充值_748b97.md');
    for (let codePoint = 0xFDD0; codePoint <= 0xFDEF; codePoint++) {
        assert.equal(sanitizeFileName(`文件${String.fromCodePoint(codePoint)}.md`), '文件.md');
    }
    for (let plane = 0; plane <= 16; plane++) {
        for (const suffix of [0xFFFE, 0xFFFF]) {
            assert.equal(sanitizeFileName(`文件${String.fromCodePoint(plane * 0x10000 + suffix)}.md`), '文件.md');
        }
    }
    assert.equal(sanitizeRelativePath('assets/图\u{5FFFF}片.png'), 'assets/图片.png');
});

test('filename sanitization removes lone surrogates and retains assigned Unicode', () => {
    const valid = '中文😀🧑🏽‍💻é e\u0301\u{31350}\uE000\u{F0000}.md';
    assert.equal(sanitizeFileName(valid), valid);
    assert.equal(sanitizeFileName('中\uD800文\uDC00😀.md'), '中文😀.md');
    assert.equal(sanitizeFileName('\uDBFF😀\uDFFF.md'), '😀.md');
});

test('native macOS EILSEQ titles lose unassigned scalars before filename reservation', () => {
    assert.equal(buildExportFileName('代码依赖可视化\u{4E7D9}', '6ab84970-7684-83e8-b454-0baaa20585e8'),
        '代码依赖可视化_0585e8.md');
    for (const codePoint of [0x378, 0x35000, 0x3E7D9, 0x40000, 0x4E7D9]) {
        assert.equal(sanitizeFileName(`文件${String.fromCodePoint(codePoint)}.md`), '文件.md');
    }
    assert.equal(sanitizeRelativePath('assets/图\u{4E7D9}片.png'), 'assets/图片.png');
    assert.equal(sanitizeFileName('\u{4E7D9}'), 'untitled');
});

test('titles containing only invalid Unicode fall back to a stable export filename', () => {
    assert.equal(sanitizeFileName('\u{5FFFF}\uD800'), 'untitled');
    assert.equal(sanitizeFileName('\uFFFF', 'attachment'), 'attachment');
    assert.equal(buildExportFileName('\u{5FFFF}\uD800', 'c_abcdef'), 'untitled_abcdef.md');
});
