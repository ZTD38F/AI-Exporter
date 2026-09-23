export {};
const test = require('node:test');
const assert = require('node:assert');

const { validateZipEntries } = require('../src/core/engine/takeout/zipBombGuard.js');

test('ZIP guard rejects distinct entries that normalize to the same output path', () => {
    const zip = {
        files: {
            'files\\report.txt': {
                dir: false,
                unsafeOriginalName: 'files\\report.txt',
                _data: { uncompressedSize: 5 }
            },
            'files/report.txt': {
                dir: false,
                unsafeOriginalName: 'files/report.txt',
                _data: { uncompressedSize: 6 }
            }
        }
    };

    assert.throws(
        () => validateZipEntries(zip),
        /Duplicate normalized ZIP entry path: files\/report\.txt/
    );
});
