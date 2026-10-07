export {};
const test = require('node:test');
const assert = require('node:assert');

const { validateZipEntries } = require('../src/core/engine/takeout/zipBombGuard.js');

function entry(path: string, size = 5) {
    return {
        dir: false,
        unsafeOriginalName: path,
        _data: { uncompressedSize: size }
    };
}

test('ZIP guard rejects distinct entries that normalize to the same output path', () => {
    const zip = {
        files: {
            'files\\report.txt': entry('files\\report.txt'),
            'files/report.txt': entry('files/report.txt', 6)
        }
    };

    assert.throws(
        () => validateZipEntries(zip),
        /Duplicate normalized ZIP entry path: files\/report\.txt/
    );
});

test('ZIP guard rejects case-insensitive aliases before portable filesystem writes', () => {
    const zip = {
        files: {
            'files/Report.txt': entry('files/Report.txt'),
            'files/report.txt': entry('files/report.txt')
        }
    };

    assert.throws(
        () => validateZipEntries(zip),
        /Portable ZIP entry path collision: files\/Report\.txt <> files\/report\.txt/
    );
});

test('ZIP guard rejects trailing-dot and trailing-space aliases used by Windows filesystems', () => {
    const zip = {
        files: {
            'files/report.txt': entry('files/report.txt'),
            'files/report.txt. ': entry('files/report.txt. ')
        }
    };

    assert.throws(
        () => validateZipEntries(zip),
        /Portable ZIP entry path collision/
    );
});

test('ZIP guard rejects Unicode normalization aliases used by common filesystems', () => {
    const composed = 'files/caf\u00e9.txt';
    const decomposed = 'files/cafe\u0301.txt';
    const zip = {
        files: {
            [composed]: entry(composed),
            [decomposed]: entry(decomposed)
        }
    };

    assert.throws(
        () => validateZipEntries(zip),
        /Portable ZIP entry path collision/
    );
});
