/**
 * tests/provider_degrade.test.ts
 * Source scripts are dynamically registered only after optional site access.
 */
import { PLATFORM_HOSTS } from '../src/shared/platformHosts.js';
import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';


test('Phase E: content-script matches are scoped to explicit HTTPS provider hosts', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.content_scripts ?? [], [], 'no platform is injected before permission');
    const patterns = Object.values(PLATFORM_HOSTS).flatMap(group => [...group.pages]);
    for (const pattern of patterns) {
        assert.match(pattern, /^https:\/\/[a-z0-9.-]+\/\*$/i, `not a narrowly scoped HTTPS host: ${pattern}`);
        assert.ok(!pattern.includes('*.'), `wildcard host is too broad: ${pattern}`);
    }
    assert.ok(patterns.includes('https://gemini.google.com/*'), 'Gemini remains supported');
    // Other explicitly supported providers may be added without rewriting this test.
});




