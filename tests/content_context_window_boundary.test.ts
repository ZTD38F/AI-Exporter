import test from 'node:test';
import assert from 'node:assert/strict';
import { ContentContext } from '../src/runtime/content/contentContext.js';

test('ContentContext works without a browser mirror and supports abort', () => {
    const context = new ContentContext(null);
    context.setDevMode(true);
    context.setCredentials({ at: 'test-at', bl: 'test-bl' });
    context.setAborted(false);
    context.abort();
    assert.equal(context.isAborted(), true);
});

test('ContentContext mirrors debug state to the injected browser only', () => {
    const mirror: Partial<Window> = {};
    const context = new ContentContext(mirror);
    context.setCredentials({ at: 'pre-dev', bl: 'pre-dev' });
    assert.equal(mirror.__gemExporterExtractedAt, undefined, 'credentials are hidden outside dev mode');

    context.setDevMode(true);
    assert.equal(mirror.__gemExporterContentContext, context);
    assert.equal(mirror.__gemExporterAborted, false);
    assert.equal(mirror.__gemExporterDevMode, true);

    context.setCredentials({ at: 'test-at', bl: 'test-bl' });
    assert.equal(mirror.__gemExporterExtractedAt, 'test-at');
    assert.equal(mirror.__geminiAt, 'test-at');
    assert.equal(mirror.__gemExporterExtractedBl, 'test-bl');
    let aborts = 0;
    const client = { abort: () => { aborts++; } };
    context.setActiveClient(client);
    assert.equal(mirror.__gemExporterActiveClient, client);
    context.abort();
    assert.equal(mirror.__gemExporterAborted, true);
    assert.equal(aborts, 1, 'abort must not be invoked twice');

    context.setDevMode(false);
    assert.equal(mirror.__gemExporterDevMode, false);
});
