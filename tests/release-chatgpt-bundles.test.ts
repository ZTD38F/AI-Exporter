import { PLATFORM_HOSTS, platformOrigins, SOURCE_PLATFORMS, type SourcePlatform } from '../src/shared/platformHosts.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

test('physical Gemini-only ZIP includes Gemini sources but excludes dormant providers', () => {
    const root = path.resolve(__dirname, '..');
    const source = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')) as { version: string };
    const archive = 'gemini-exporter-v' + source.version + '.zip';
    execFileSync(process.execPath, ['build.js', '--pack'], { cwd: root, stdio: 'pipe' });
    const manifest = JSON.parse(execFileSync('unzip', ['-p', archive, 'manifest.json'],
        { cwd: root, encoding: 'utf8' })) as { host_permissions: string[]; optional_host_permissions: string[] };
    assert.deepEqual(manifest.host_permissions ?? [], []);
    assert.deepEqual([...manifest.optional_host_permissions].sort(), [...platformOrigins('gemini')].sort());
    const entries = execFileSync('unzip', ['-Z1', archive], { cwd: root, encoding: 'utf8' }).split('\n');
    for (const file of ['dist/content/hook.js', 'dist/content/content.js']) {
        assert.ok(entries.includes(file), 'missing expected Gemini source bundle ' + file);
        assert.ok(execFileSync('unzip', ['-p', archive, file], { cwd: root }).length > 0);
    }
    assert.ok(!entries.some(name => /^dist\/content\/(chatgpt|claude|grok)-/.test(name)),
        'inactive provider bundles must not be released');
    const notices = execFileSync('unzip', ['-p', archive, 'THIRD_PARTY_NOTICES.md'],
        { cwd: root, encoding: 'utf8' });
    assert.ok(notices.length > 0);
    assert.ok(!entries.some(name => name.startsWith('temp/')));
});
