import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sources } from '../scripts/audit-provider-fixtures.cjs';

test('Grok source and browser mocks use matching native endpoint generators', () => {
    for (const file of sources(__dirname)) {
        if (file.includes('/fixtures/providers/') || file.endsWith('grok_rpc_fixture_closure.test.ts')) continue;
        const source = readFileSync(file, 'utf8');
        if (!/\b(?:GrokProvider|parseGrokList|readGrokSource|grokDetailGen)\b/.test(source)) continue;
        assert.doesNotMatch(source, /grok(?:Image)?Detail\.json|parseGrokList\(\s*\{/, file);
        assert.doesNotMatch(source, /return\s+(?:\[\s*\{\s*result\s*:\s*)?\{\s*(?:conversations|userId|responseNodes|responses)\s*:/, file);
    }
});
