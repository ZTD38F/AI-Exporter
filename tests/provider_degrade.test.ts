/**
 * tests/provider_degrade.test.ts
 * PR1 subtraction 后保留的真实 provider 测试：
 * - manifest content_scripts 无 ChatGPT 域名匹配
 * - 三处 resolveProvider 收口到 src/core/provider/providerResolver.ts
 */
import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { resolveProvider } from '../src/core/provider/providerResolver.js';

test('Phase E: manifest content_scripts 无 ChatGPT 域名匹配', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
    const patterns: string[] = [];
    for (const cs of manifest.content_scripts || []) {
        for (const m of cs.matches || []) patterns.push(m);
    }
    assert.ok(patterns.length > 0, 'manifest 应有 content_scripts');
    for (const p of patterns) {
        assert.ok(!/chatgpt|openai/i.test(p), `content_scripts 不应覆盖 ChatGPT 域名: ${p}`);
    }
});

test('Phase E: 三处 resolveProvider 收口到共享 helper', () => {
    const files = [
        'src/content/syncEngine.ts',
        'src/content/messageRouter.ts',
        'src/content/liveSaveCoordinator.ts'
    ];
    for (const f of files) {
        const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
        assert.ok(src.includes("from '../core/provider/providerResolver.js'"),
            `${f} 应从 providerResolver 导入 resolveProvider`);
        assert.ok(!/^\s*(const|function)\s+resolveProvider\s*\(/m.test(src),
            `${f} 不应再有本地 resolveProvider 定义`);
    }
});

test('Phase E: 共享 resolveProvider 行为与原来一致（无 location 时回落 default）', () => {
    assert.strictEqual(resolveProvider()?.id, 'gemini',
        'node 环境无 location，应回落到 default provider');
});
