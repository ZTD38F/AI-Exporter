import { fixtureAccountFor } from './helpers/domainFixture.js';
import { restoreDomainSnapshot } from '../src/l2/runtimeValidation.js';
import { historicalFixture } from './helpers/nativeFixture.js';
/** Runtime closure and JSON portability of actual Domain and Document AST fixtures. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { assertDomainClosure } from '../src/l2/closure.js';
import { composeDomainDocument } from '../src/l3b/compose/composeDomainDocument.js';
import { renderDocumentHtml } from '../src/l4/format/html/renderHtml.js';
import { renderDocumentMarkdown } from '../src/l4/format/markdown/renderMarkdown.js';
import { renderDocumentTypst } from './helpers/renderTypstFixture.js';
test('each Domain fixture is closed and JSON round-trip preserves every backend output', () => {
    const dir = join(__dirname, 'fixtures', 'document-domain');
    const files = readdirSync(dir).filter(file => file.endsWith('.json'));
    assert.ok(files.length > 0, 'the document-domain fixture suite must not be empty');
    for (const file of files) {
        const fixture: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'));
        const domain = restoreDomainSnapshot(fixture);
        assertDomainClosure((domain).detail);
        const before = JSON.stringify(domain);
        const document = composeDomainDocument(domain, fixtureAccountFor(domain));
        const roundTrip = composeDomainDocument(restoreDomainSnapshot(JSON.parse(before)), fixtureAccountFor(restoreDomainSnapshot(JSON.parse(before))));
        assert.deepEqual(roundTrip, document, file);
        const backends = [renderDocumentHtml, renderDocumentMarkdown, renderDocumentTypst];
        for (const backend of backends) assert.deepEqual(backend(document, {}), backend(roundTrip, {}), file);
        assert.equal(JSON.stringify(domain), before);
        const json = JSON.stringify(document);
        for (const field of ['conversation', 'assets', 'reasoning', 'storageRef', 'sourceRef', 'initiallyCollapsed', 'pdfLayout', 'measurementText', 'frontMatter', 'theme', 'modelLabel']) assert.ok(!json.includes(`"${field}":`), `${file}: ${field}`);
    }
});
test('provider-only state and malformed title data cannot become document context', () => {
    const raw = { id: 'state', title: { text: 'not a title' }, theme: 'dark', messages: [{ role: 'model', content: 'Authored content', initiallyCollapsed: false }] };
    const original = structuredClone(raw);
    const { conversation } = historicalFixture(raw as never, { providerId: 'gemini' });
    assert.equal(typeof conversation.index.title, 'undefined');
    const document = composeDomainDocument(conversation, fixtureAccountFor(conversation));
    assert.ok(!JSON.stringify(document).includes('initiallyCollapsed'));
    assert.ok(!JSON.stringify(document).includes('not a title'));
    assert.deepEqual(raw, original);
});
