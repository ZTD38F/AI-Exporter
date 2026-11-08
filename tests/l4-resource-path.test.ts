/** Pure L4 resource path tests with a frozen v2 AST input. L1 extraction is tested separately. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeArchiveResourceName } from '../src/shared/utils/archivePath.js';
import { renderDocumentHtml } from '../src/l4/format/html/renderHtml.js';
import { v2Document } from './helpers/l4V2Fixtures.js';

test('L4 archive paths preserve namespaces, and bare filenames use assets', () => {
    for (const [input, expected] of [
        ['foo.png', 'assets/foo.png'], ['assets/foo.png', 'assets/foo.png'],
        ['files/foo.md', 'files/foo.md'], ['files/nested/foo.pdf', 'files/nested/foo.pdf'],
        ['./files//foo.md', 'files/foo.md'], ['files\\nested\\foo.pdf', 'files/nested/foo.pdf'],
    ]) assert.equal(normalizeArchiveResourceName(input), expected);
});
test('L4 archive paths reject traversal, absolute drives and encoded separators', () => {
    for (const path of ['../foo', '../../etc/passwd', '/absolute/path', 'C:/foo', '//server/foo',
        'files/../foo', 'files/%2e%2e/foo', '%2fabsolute', 'files/%00foo', 'files/..\\foo']) {
        assert.throws(() => normalizeArchiveResourceName(path), /archive resource path/i);
    }
});
test('L4 archive paths preserve legitimate literal percent characters', () => {
    for (const [input, expected] of [
        ['75%酒精.jpg', 'assets/75%酒精.jpg'], ['5%阿昔洛韦.png', 'assets/5%阿昔洛韦.png'],
        ['files/report_50%.md', 'files/report_50%.md'], ['files/test%.pdf', 'files/test%.pdf'],
        ['assets/100%_pure.webp', 'assets/100%_pure.webp'],
    ]) assert.equal(normalizeArchiveResourceName(input), expected);
});
test('L4 HTML takes a prepared files/ path from Packaging, not an L1 attachment parser', () => {
    const document = v2Document([{ type: 'file', kind: 'file', resourceId: 'resource-1', label: 'test_config.json' }]);
    const result = renderDocumentHtml(document, { 'resource-1': 'files/cb8bd7_test_config.json' });
    assert.match(result.html, /href="files\/cb8bd7_test_config.json"/);
    assert.deepEqual(result.diagnostics, []);
});
