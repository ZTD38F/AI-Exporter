/**
 * tests/canonical-html-renderer-adapter.test.ts
 * F2c: CanonicalHtmlRenderer adapter -- ExportArtifact shape and companion
 * resource plan through a RenderContext AssetResolver.
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

const { normalizeGeminiConversation, CanonicalHtmlRenderer } = require('../src/core/export/canonical/index.js');

function makeContext(bundle: any, resolve: (id: string) => Promise<any>): any {
    return {
        bundle,
        assets: { resolve },
        locale: 'zh',
        signal: AbortSignal.timeout(10000),
        reportProgress: () => {},
    };
}

test('adapter: artifact shape, companion ids, offline urls', async () => {
    const chat: any = {
        id: 'adapter_001',
        title: 'Adapter Test',
        messages: [
            {
                role: 'user',
                content: 'look at this',
                attachments: [{ type: 'image', localName: 'assets/x.png', name: 'x.png' }],
            },
        ],
    };
    const { bundle } = await normalizeGeminiConversation(chat);
    const asset = bundle.assets[0];
    const renderer = new CanonicalHtmlRenderer();
    const artifact = await renderer.render(makeContext(bundle, async (id: string) =>
        id === asset.id ? { asset, renderUrl: 'assets/x.png' } : null,
    ));
    assert.strictEqual(artifact.mimeType, 'text/html');
    assert.ok(String(artifact.content).startsWith('<!DOCTYPE html>'));
    assert.ok(artifact.fileName.endsWith('.html'));
    assert.deepStrictEqual(artifact.companionResourceIds, [asset.id]);
    assert.deepStrictEqual(artifact.companionPlan?.omitted, []);
    assert.ok(String(artifact.content).includes('assets/x.png'), 'resolved renderUrl used');
});

test('adapter: unresolvable asset lands in omitted, still renders', async () => {
    const chat: any = {
        id: 'adapter_002',
        title: 'Adapter Omitted',
        messages: [
            {
                role: 'model',
                content: 'file below',
                attachments: [{ type: 'file', localName: 'assets/y.pdf', name: 'y.pdf' }],
            },
        ],
    };
    const { bundle } = await normalizeGeminiConversation(chat);
    const asset = bundle.assets[0];
    const renderer = new CanonicalHtmlRenderer();
    const artifact = await renderer.render(makeContext(bundle, async () => null));
    assert.deepStrictEqual(artifact.companionResourceIds, []);
    assert.strictEqual(artifact.companionPlan?.omitted.length, 1);
    assert.strictEqual(artifact.companionPlan?.omitted[0].resourceId, asset.id);
    assert.ok(String(artifact.content).includes('gem-missing-asset'), 'visible placeholder kept');
});

test('adapter: aborted signal stops the render', async () => {
    const chat: any = { id: 'adapter_003', title: 'T', messages: [{ role: 'user', content: 'hi' }] };
    const { bundle } = await normalizeGeminiConversation(chat);
    const renderer = new CanonicalHtmlRenderer();
    const controller = new AbortController();
    controller.abort();
    const ctx = makeContext(bundle, async () => null);
    ctx.signal = controller.signal;
    await assert.rejects(() => renderer.render(ctx));
});
