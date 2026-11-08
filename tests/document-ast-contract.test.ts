import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { mockAccount, givenReadonlyDomain, composeDomainDocument } from './helpers/l3bUnitHarness.js';
import { assertDocumentAst, assertDocumentAsts } from './helpers/assertDocumentAst.js';
import type { DomainConversationWithDetail } from '../src/l2/conversation.js';

const valid = () => ({
    title: 'T',
    metadata: { id: 'fixture', provider: 'test', createdAt: 0 },
    messages: [{ role: 'assistant', timestamp: 1000, modelLabel: 'Model',
        blocks: [{ type: 'paragraph', children: [{ type: 'strong', children: [{ type: 'image', resourceId: 'i', alt: 'Image' }] }] }],
        sources: [{ id: 'c', label: 'Article', number: 1 }],
    }],
});

test('all visual and parity fixtures satisfy the canonical DocumentAst TypeScript contract', () => {
    const entries: Array<{ value: unknown; context: string }> = [];
    for (const directory of ['tests/fixtures/visual-corpus', 'tests/parity-corpus']) {
        const files = readdirSync(directory).filter(file => file.endsWith('.json'));
        assert.ok(files.length, directory);
        for (const file of files) {
            const fixture = JSON.parse(readFileSync(directory + '/' + file, 'utf8'));
            entries.push({ value: fixture.document, context: directory + '/' + file });
        }
    }
    for (const file of readdirSync('tests/fixtures/document-domain').filter(file => file.endsWith('.json'))) {
        const input: DomainConversationWithDetail = JSON.parse(readFileSync('tests/fixtures/document-domain/' + file, 'utf8'));
        const domain = givenReadonlyDomain(input);
        entries.push({ value: composeDomainDocument(domain, mockAccount('example', domain.index.key.accountId)), context: file });
    }
    assertDocumentAsts(entries);
});

test('contract rejects stale fields, bad types and a second sources wrapper', () => {
    assertDocumentAst(valid());
    const mutate: Array<(value: ReturnType<typeof valid>) => void> = [
        value => Object.assign(value, { schemaVersion: 2 }),
        value => Object.assign(value, { header: { title: 'Legacy' } }),
        value => Object.assign(value, { documentLanguage: 'en' }),
        value => Object.assign(value.metadata, { url: 'https://obsolete.example' }),
        value => Object.assign(value.metadata, { createdAt: '2026-01-01T00:00:00Z' }),
        value => Object.assign(value.messages[0], { type: 'message' }),
        value => Object.assign(value.messages[0], { id: 'msg-0' }),
        value => Object.assign(value.messages[0], { variant: 'flow' }),
        value => Object.assign(value.messages[0], { label: 'you' }),
        value => Object.assign(value.messages[0], { role: 'model' }),
        value => Object.assign(value.messages[0], { timestamp: '2026-01-01' }),
        value => Object.assign(value.messages[0], { sources: { items: [] } }),
        value => Object.assign(value.messages[0], { sources: [{ id: 'c', label: 'Unnumbered' }] }),
        value => Object.assign(value.messages[0], { blocks: [{ type: 'placeholder', kind: 'file', text: 'Absent' }] }),
        value => Object.assign(value.messages[0], { blocks: [{ type: 'file', resourceId: 'f', label: 'Attachment' }] }),
        value => Object.assign(value.messages[0], { blocks: [{ type: 'image', resourceId: 'i' }] }),
        value => Object.assign(value.messages[0], { blocks: [{ type: 'paragraph', children: [{ type: 'citation', id: 'c' }] }] }),
        value => Object.assign(value.messages[0], { blocks: [{ type: 'table', columnAlignments: ['default'], headerRows: [], rows: [[{ column: 0, colSpan: 1, rowSpan: 1, align: 'left', children: [] }]] }] }),
        value => Object.assign(value, { diagnostics: [] }),
        value => Object.assign(value.messages[0], { blocks: [{ type: 'disclosure', kind: 'reasoning', blocks: [] }] }),
    ];
    for (const change of mutate) {
        const value = valid(); change(value);
        assert.throws(() => assertDocumentAst(value), TypeError);
    }
});
