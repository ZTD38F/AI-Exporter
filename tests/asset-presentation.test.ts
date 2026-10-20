export {};
const test = require('node:test');
const assert = require('node:assert/strict');
const { assetPresentation, isHumanMeaningfulFilename } = require('../src/core/export/canonical/assetPresentation.js');
const { renderCanonicalMarkdown } = require('../src/core/export/canonical/renderCanonicalMarkdown.js');
const { renderCanonicalHtml } = require('../src/core/export/canonical/renderCanonicalHtml.js');
const { toTypstPayload } = require('../src/core/export/typst/payload.js');

test('asset labels suppress opaque storage names and preserve meaningful multilingual names', () => {
    for (const name of ['watermarked_img_11204364633950674587.jpg', 'asset_123456.png', 'a'.repeat(32) + '_photo.jpg', '123456789.jpg', 'https://host/internal.png', 'a1b2c3d4-1234-4321-abcd-123456789012.png']) {
        assert.equal(isHumanMeaningfulFilename(name), false, name);
    }
    for (const name of ['实验示意图.png', 'test_config.json', 'Figure 2 — PSF', 'Figure: PSF', 'report-2026.pdf']) assert.equal(isHumanMeaningfulFilename(name), true, name);
    assert.equal(assetPresentation({ name: 'asset_123.png' }, 'Human caption').caption, 'Human caption');
});

test('opaque generated image caption policy agrees across Markdown HTML and Typst', () => {
    const name = 'watermarked_img_11204364633950674587.jpg';
    const b = { schemaVersion: 1, conversation: { key: { providerId: 'gemini', accountId: 'a', conversationId: 'c' }, title: 'Title', messages: [{ id: 'm', role: 'assistant', blocks: [{ type: 'image', assetId: 'i', alt: name, caption: [{ type: 'text', text: name }] }] }] }, assets: [{ id: 'i', name, kind: 'image', status: 'available', storageRef: 'assets/image.jpg' }], citations: [] };
    const md = renderCanonicalMarkdown(b);
    assert.ok(md.includes('![Image](assets/image.jpg)'));
    assert.ok(!md.includes(name));
    const { payload } = toTypstPayload(b, { assetPath: () => '/assets/image.jpg' });
    assert.equal(payload.messages[0].blocks[0].caption, undefined);
    // HTML keeps the asset reference in href, but no opaque display label.
    const result = renderCanonicalHtml(b);
    assert.ok(!JSON.stringify(result).includes(name));
    assert.ok(result.html.includes('<h1 class="gem-conversation-title">Title</h1>'));
});
