export {};
const test = require('node:test');
const assert = require('node:assert');
const DomScraper = require('../src/content/domScraper.js');

test('dom_scraper - exports and methods', () => {
    assert.strictEqual(typeof DomScraper.cleanText, 'function');
    assert.strictEqual(typeof DomScraper.parseDoc, 'function');
    assert.strictEqual(typeof DomScraper.getScrollContainer, 'function');
    assert.strictEqual(typeof DomScraper.getConversationLinks, 'function');
    assert.strictEqual(typeof DomScraper.tryExpandRecents, 'function');
});

test('dom_scraper - cleanText functionality', () => {
    assert.strictEqual(DomScraper.cleanText('  Hello\u00a0World\r\n  '), 'Hello World');
    assert.strictEqual(DomScraper.cleanText(''), '');
    assert.strictEqual(DomScraper.cleanText(null), '');
});
