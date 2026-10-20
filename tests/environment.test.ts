export {};
const test = require('node:test');
const assert = require('node:assert');
const { isLocalDevelopment } = require('../src/core/utils/environment.js');

test('environment - returns true when chrome runtime has no update_url (unpacked dev)', () => {
    const originalChrome = (global as any).chrome;
    try {
        (global as any).chrome = {
            runtime: {
                getManifest: () => ({
                    name: 'Gemini Exporter',
                    version: '1.6.0'
                    // No update_url
                })
            }
        };
        assert.strictEqual(isLocalDevelopment(), true);
    } finally {
        (global as any).chrome = originalChrome;
    }
});

test('environment - returns false when update_url is present (Chrome Web Store production)', () => {
    const originalChrome = (global as any).chrome;
    try {
        (global as any).chrome = {
            runtime: {
                getManifest: () => ({
                    name: 'Gemini Exporter',
                    version: '1.6.0',
                    update_url: 'https://clients2.google.com/service/update2/crx'
                })
            }
        };
        assert.strictEqual(isLocalDevelopment(), false);
    } finally {
        (global as any).chrome = originalChrome;
    }
});

test('environment - respects ?dev=1 query parameter override', () => {
    const originalChrome = (global as any).chrome;
    const originalWindow = (global as any).window;
    try {
        (global as any).chrome = {
            runtime: {
                getManifest: () => ({
                    name: 'Gemini Exporter',
                    version: '1.6.0',
                    update_url: 'https://clients2.google.com/service/update2/crx'
                })
            }
        };
        (global as any).window = {
            location: { search: '?dev=1' }
        };
        assert.strictEqual(isLocalDevelopment(), true);
    } finally {
        (global as any).chrome = originalChrome;
        (global as any).window = originalWindow;
    }
});

test('environment - respects ?prod=1 query parameter override', () => {
    const originalChrome = (global as any).chrome;
    const originalWindow = (global as any).window;
    try {
        (global as any).chrome = {
            runtime: {
                getManifest: () => ({
                    name: 'Gemini Exporter',
                    version: '1.6.0'
                })
            }
        };
        (global as any).window = {
            location: { search: '?prod=1' }
        };
        assert.strictEqual(isLocalDevelopment(), false);
    } finally {
        (global as any).chrome = originalChrome;
        (global as any).window = originalWindow;
    }
});

test('environment - gracefully falls back to true in non-extension environments', () => {
    const originalChrome = (global as any).chrome;
    try {
        delete (global as any).chrome;
        assert.strictEqual(isLocalDevelopment(), true);
    } finally {
        (global as any).chrome = originalChrome;
    }
});
