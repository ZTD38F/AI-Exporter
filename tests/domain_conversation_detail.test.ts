import { fixtureKey } from './helpers/domainFixture.js';
const { messageAssets } = require('./helpers/domainAssets.js');
export {};
const test = require('node:test');
const assert = require('node:assert/strict');
const { historicalFixtureDomain, historicalFixture } = require('./helpers/nativeFixture.js');
const { composeFixture } = require('./helpers/documentFixture.js');

// Explicit plain-text AST expectations for the metadata-focused fixtures below.
function plainContent(text: string): unknown[] {
    if (!text.trim()) return [];
    const children: unknown[] = [];
    for (const [index, line] of text.trim().split('\n').entries()) {
        if (index) children.push({ type: 'lineBreak', kind: 'soft' });
        if (line) children.push({ type: 'text', text: line });
    }
    return [{ type: 'paragraph', children }];
}
function assertDomainMessages(actual: Array<Record<string, unknown>>, expected: Array<Record<string, unknown>>): void {
    assert.deepEqual(actual, expected.map((message, index) => {
        const { attachments, reasoning, ...core } = message;
        const resources = attachments as unknown[] | undefined;
        if (resources) assert.equal((actual[index].attachmentIds as string[]).length, resources.length);
        return { ...core,
            content: typeof message.content === 'string' ? plainContent(message.content) : message.content,
            ...(typeof reasoning === 'string' ? { reasoning: reasoning.split(/\n\n+/).flatMap(plainContent) } : {}),
            ...(resources ? { attachmentIds: actual[index].attachmentIds } : {}),
        };
    }));
}

async function assertExportEquivalent(legacy: Record<string, unknown>): Promise<void> {
    const { conversation: domain, resourceHints } = historicalFixture(legacy as never);
    const [before, after] = await Promise.all([
        composeFixture(historicalFixture(legacy as never, { providerId: 'gemini' }).conversation, resourceHints),
        composeFixture(domain, resourceHints),
    ]);
    assert.deepEqual(after.document, before.document);
}

const base = { id: 'conversation-1', title: 'Example', timestamp: 1700000000000 };

test('Domain adapter preserves a normal RPC conversation and message order', async () => {
    const conversation = {
        ...base,
        updatedAt: 1700000001000,
        url: 'https://gemini.google.com/app/conversation-1',
        messages: [
            { id: '10000000-0000-4000-8000-000000000002', role: 'user', content: 'Question', timestamp: 1700000000000 },
            { id: 'a1', role: 'model', content: 'Answer', timestamp: 1700000001000 },
        ],
    };
    await assertExportEquivalent(conversation);
    const domain = historicalFixtureDomain(conversation);
    assert.deepEqual(domain.detail.messages.map((m: { id?: string }) => m.id), ['10000000-0000-4000-8000-000000000002', 'a1']);
    assert.equal('turns' in domain, false);
});

test('Domain adapter omits missing and null message timestamps while preserving conversation timestamp', async () => {
    const conversation = {
        ...base,
        timestamp: null,
        messages: [
            { role: 'user', content: 'No timestamp' },
            { role: 'assistant', content: 'Null timestamp', timestamp: null },
        ],
    };
    const domain = historicalFixtureDomain(conversation);
    assert.equal(Object.hasOwn(domain, 'timestamp'), false);
    assert.equal('timestamp' in domain.detail.messages[0], false);
    assert.equal('timestamp' in domain.detail.messages[1], false);
    await assertExportEquivalent(conversation);
});

test('Domain adapter preserves attachments and images without mutating binary data', async () => {
    const conversation = {
        ...base,
        messages: [{ role: 'user', content: 'See image', attachments: [
            { type: 'image', localName: 'image.png', dataBase64: 'AQID', mimeType: 'image/png' },
        ], images: [{ type: 'image', url: 'https://example.test/image.png', isImage: true }] }],
    };
    const original = structuredClone(conversation);
    const domain = historicalFixtureDomain(conversation);
    assert.deepEqual(conversation, original);
    assert.equal(messageAssets(domain)?.[0].dataBase64, undefined);
    await assertExportEquivalent(conversation);
});

test('Domain adapter preserves generated media identity and export output', async () => {
    const conversation = {
        ...base,
        messages: [{ role: 'model', content: 'Generated', attachments: [{
            type: 'image', isGenerated: true, url: 'https://example.test/generated.png',
            generation: { chatId: 'conversation-1', providerRequestId: 'request-1', time: null, prompt: 'A lake', generationOrdinal: 2, imageCount: 1, imageOrdinal: 0, turnId: 'turn-2' },
        }] }],
    };
    await assertExportEquivalent(conversation);
    assert.equal(messageAssets(historicalFixtureDomain(conversation))?.[0].generation?.time, undefined);
    assert.equal('time' in (messageAssets(historicalFixtureDomain(conversation))?.[0].generation ?? {}), false);
});

test('Domain adapter preserves citations, document metadata, reasoning, and structured body semantics', async () => {
    const conversation = {
        ...base,
        messages: [{
            role: 'assistant', content: 'Answer [1]', thoughts: ['Reasoned step'], thinking: 'Alternate reasoning',
            citations: [{ url: 'https://example.test/source', title: 'Source' }],
            documents: [{ type: 'doc', id: 'doc-1', title: 'Report', url: 'https://example.test/report', contentMarkdown: '# Report', sections: ['Intro'], links: [{ title: 'Source', url: 'https://example.test/source' }] }],
            structuredContent: { type: 'text', text: 'Structured answer' }, groundingCitationMarkers: ['[cite:1]'],
        }],
    };
    await assertExportEquivalent(conversation);
});

test('Domain adapter preserves Takeout-style turns-only conversations', async () => {
    const conversation = {
        ...base,
        source: 'takeout',
        turns: [{ timestamp: null, userContent: 'Question', modelContent: 'Answer', thoughts: ['Thought'], attachments: [{ type: 'file', fileName: 'input.pdf' }] }],
    };
    const domain = historicalFixtureDomain(conversation);
    assertDomainMessages(domain.detail.messages, [
        { role: 'user', content: 'Question' },
        {
            role: 'assistant', content: 'Answer', reasoning: 'Thought',
            attachments: [{ type: 'file', fileName: 'input.pdf' }],
        },
    ]);
    assert.equal('turns' in domain, false);
    await assertExportEquivalent(conversation);
});

test('Domain adapter flattens legacy turn.messages in order', async () => {
    const conversation = {
        ...base,
        turns: [{ messages: [
            { id: 'turn-user', role: 'user', content: 'First', timestamp: 100 },
            { id: 'turn-model', role: 'model', content: 'Second', timestamp: null },
        ] }],
    };
    const domain = historicalFixtureDomain(conversation);
    assertDomainMessages(domain.detail.messages.map((message: { id?: string; role: string; content: unknown[]; timestamp?: number }) => ({ id: message.id, role: message.role, content: message.content, timestamp: message.timestamp })), [
        { id: 'turn-user', role: 'user', content: 'First', timestamp: 100 },
        { id: 'turn-model', role: 'assistant', content: 'Second', timestamp: undefined },
    ]);
    assert.equal('turns' in domain, false);
    await assertExportEquivalent(conversation);
});

test('Domain output always has an empty messages array when legacy body is absent', async () => {
    const conversation = { ...base };
    const domain = historicalFixtureDomain(conversation);
    assertDomainMessages(domain.detail.messages, []);
    assert.equal('turns' in domain, false);
    await assertExportEquivalent(conversation);
});

test('Domain adapter preserves OpenAI-style assistant role and message data', async () => {
    const conversation = {
        ...base,
        titleSource: 'openai',
        messages: [{ id: 'openai-1', role: 'assistant', content: 'Hello', timestamp: null, citations: [{ url: 'https://example.test' }] }],
    };
    await assertExportEquivalent(conversation);
    assert.equal(historicalFixtureDomain(conversation).detail.messages?.[0].role, 'assistant');
});

for (const body of ['messages', 'turns'] as const) {
    test(`Domain adapter normalizes all legacy roles from ${body}`, async () => {
        const messages = [
            { id: 'system-1', role: 'system', content: 'Instruction', timestamp: null },
            { id: 'user-1', role: 'user', content: 'Question', timestamp: 100 },
            { id: 'model-1', role: 'model', content: 'Gemini answer', timestamp: 200 },
            { id: 'assistant-1', role: 'assistant', content: 'Other answer' },
        ];
        const conversation = {
            ...base,
            ...(body === 'messages' ? { messages } : { turns: [{ messages }] }),
        };
        const original = structuredClone(conversation);
        const domain = historicalFixtureDomain(conversation);
        assertDomainMessages(domain.detail.messages, [
            { id: 'system-1', role: 'system', content: 'Instruction' },
            messages[1], { ...messages[2], role: 'assistant' }, messages[3],
        ]);
        assert.deepEqual(domain.detail.messages.map((message: { role: string }) => message.role), [
            'system', 'user', 'assistant', 'assistant',
        ]);
        assert.deepEqual(conversation, original);
        await assertExportEquivalent(conversation);
    });
}

for (const body of ['messages', 'turns'] as const) {
    test(`Domain adapter normalizes message core from ${body} without synthesizing IDs or mutating input`, async () => {
        const messages = [
            { id: 'stable-id', role: 'user', content: '  Unchanged\n正文  ', timestamp: 1700000000123 },
            { role: 'assistant', content: '', timestamp: null },
            { role: 'system', content: 'No timestamp' },
            { id: undefined, role: 'assistant', content: 'Explicit undefined', timestamp: undefined },
            { role: 'user', content: 'Epoch', timestamp: 0 },
            { role: 'assistant', content: 'Before epoch', timestamp: -1000 },
        ];
        const conversation = { ...base, ...(body === 'messages' ? { messages } : { turns: [{ messages }] }) };
        const original = structuredClone(conversation);
        const domain = historicalFixtureDomain(conversation);
        assertDomainMessages(domain.detail.messages, [
            messages[0],
            { role: 'assistant', content: '' },
            messages[2],
            { role: 'assistant', content: 'Explicit undefined' },
            messages[4], messages[5],
        ]);
        for (const message of domain.detail.messages.slice(1)) assert.equal('id' in message, false);
        for (const message of domain.detail.messages.slice(1, 4)) assert.equal('timestamp' in message, false);
        assert.deepEqual(conversation, original);
        await assertExportEquivalent(conversation);
    });

    test(`Domain adapter omits invalid IDs and timestamps from ${body}`, () => {
        const messages = [NaN, Infinity, -Infinity, '123', null, undefined].map((timestamp) => ({
            id: 123, role: 'user', content: 'Unchanged', timestamp,
        }));
        const conversation = { ...base, ...(body === 'messages' ? { messages } : { turns: [{ messages }] }) };
        const original = structuredClone(conversation);
        const domain = historicalFixtureDomain(conversation);
        assertDomainMessages(domain.detail.messages, messages.map(() => ({ role: 'user', content: 'Unchanged' })));
        assert.deepEqual(conversation, original);
    });

    test(`legacy record migration retains unknown message content from ${body}`, () => {
        for (const content of [123, {}, [], false]) {
            const messages = [{ role: 'user', content }];
            const conversation = { ...base, ...(body === 'messages' ? { messages } : { turns: [{ messages }] }) };
            const original = structuredClone(conversation);
            const result = historicalFixture(conversation);
            assert.ok(result.diagnostics.some((d: { code: string }) => d.code === 'UNKNOWN_MESSAGE_CONTENT'));
            assert.deepEqual(conversation, original);
        }
    });
}

test('Domain adapter applies core timestamp invariants to synthesized turns without generating IDs', async () => {
    for (const timestamp of [1700000000123, 0, -1000, null, undefined, NaN, Infinity, -Infinity, '123']) {
        const conversation = { ...base, turns: [{ userContent: '  Question  ', modelContent: 'Answer\n正文', timestamp }] };
        const original = structuredClone(conversation);
        const domain = historicalFixtureDomain(conversation);
        const expectedTimestamp = typeof timestamp === 'number' && Number.isFinite(timestamp) ? { timestamp } : {};
        assertDomainMessages(domain.detail.messages, [
            { role: 'user', content: '  Question  ', ...expectedTimestamp },
            { role: 'assistant', content: 'Answer\n正文', ...expectedTimestamp },
        ]);
        for (const message of domain.detail.messages) assert.equal('id' in message, false);
        assert.deepEqual(conversation, original);
        if (timestamp === null || timestamp === undefined || typeof timestamp === 'number' && Number.isFinite(timestamp)) {
            await assertExportEquivalent(conversation);
        }
    }
});

test('legacy record migration preserves attachment-only empty turn content', async () => {
    const conversation = { ...base, turns: [{ attachments: [{ type: 'file', fileName: 'input.pdf' }], timestamp: null }] };
    assertDomainMessages(historicalFixtureDomain(conversation).detail.messages, [
        { role: 'assistant', content: '', attachments: [{ type: 'file', fileName: 'input.pdf' }] },
    ]);
    await assertExportEquivalent(conversation);
});

for (const body of ['messages', 'turns'] as const) {
    test(`Domain message whitelist excludes legacy counts and unknown fields from ${body}`, async () => {
        const message = {
            id: 'stable-id', role: 'assistant', content: 'Answer', timestamp: 1700000000123,
            turnId: 'turn-1', providerRequestId: 'request-1',
            generation: { chatId: base.id, generationOrdinal: 1 },
            attachments: [{ type: 'file', fileName: 'input.pdf' }],
            thoughts: 'Reasoning', thinking: 'Alternate reasoning',
            citations: [{ url: 'https://example.test/source', title: 'Source' }],
            images: [{ type: 'image', url: 'https://example.test/image.png' }],
            documents: [{ type: 'doc', id: 'doc-1', contentMarkdown: '# Report' }],
            sources: [{ url: 'https://example.test/source' }],
            structuredContent: { type: 'text', text: 'Answer' },
            groundingCitationMarkers: ['[cite:1]'],
            attachmentCount: 3, messageCount: 2, futureLegacyField: 'must not leak',
        };
        const conversation = { ...base, ...(body === 'messages' ? { messages: [message] } : { turns: [{ messages: [message] }] }) };
        const original = structuredClone(conversation);
        const domain = historicalFixtureDomain(conversation);
        const expected = {
            id: message.id, role: message.role, content: message.content, timestamp: message.timestamp,
            attachments: [...message.attachments, ...message.images, ...message.documents],
            reasoning: message.thoughts,
            citations: [{ ...message.citations[0], id: 'citation-0' }, { id: 'grounding-1' }],
        };
        assertDomainMessages(domain.detail.messages, [expected]);
        for (const field of ['attachmentCount', 'messageCount', 'futureLegacyField', 'generation', 'thoughts', 'thinking', 'sources', 'structuredContent', 'contentAst', 'images', 'documents', 'groundingCitationMarkers']) {
            assert.equal(field in domain.detail.messages[0], false);
        }
        assert.deepEqual(conversation, original);
        await assertExportEquivalent(conversation);
    });

    test(`Domain adapter omits empty or whitespace-only IDs from ${body} and preserves valid IDs verbatim`, () => {
        const ids = ['', '   ', '\t\n', ' stable-id ', 'stable-id'];
        const messages = ids.map((id) => ({ id, role: 'user', content: 'Question' }));
        const conversation = { ...base, ...(body === 'messages' ? { messages } : { turns: [{ messages }] }) };
        const original = structuredClone(conversation);
        const domain = historicalFixtureDomain(conversation);
        for (const message of domain.detail.messages.slice(0, 3)) assert.equal('id' in message, false);
        assert.equal(domain.detail.messages[3].id, ' stable-id ');
        assert.equal(domain.detail.messages[4].id, 'stable-id');
        assert.deepEqual(conversation, original);
    });
}

for (const body of ['messages', 'turns'] as const) {
    test(`Domain adapter drops message turnId and preserves opaque request provenance from ${body}`, async () => {
        for (const [requestId, normalized] of [
            ['r_abcd1234', 'r_abcd1234'], ['ABCD1234', 'ABCD1234'],
            [' R_ABCD1234 ', 'R_ABCD1234'], ['abcd1234', 'abcd1234'],
            ['r_r_ABCD1234', 'r_r_ABCD1234'], ['r_', 'r_'], [' R_ ', 'R_'],
            [' OpenAI-Request-XyZ ', 'OpenAI-Request-XyZ'], ['Claude_Req:AbC', 'Claude_Req:AbC'],
        ]) {
            const messages = [{ id: 'message-1', role: 'assistant', content: 'Answer', turnId: 'turn-1', providerRequestId: requestId }];
            const conversation = { ...base, ...(body === 'messages' ? { messages } : { turns: [{ messages }] }) };
            const original = structuredClone(conversation);
            const domain = historicalFixtureDomain(conversation);
            assertDomainMessages(domain.detail.messages, [{ id: 'message-1', role: 'assistant', content: 'Answer' }]);
            assert.equal('turnId' in domain.detail.messages[0], false);
            assert.equal('providerRequestId' in domain.detail.messages[0], false);
            assert.deepEqual(conversation, original);
            await assertExportEquivalent(conversation);
        }
    });

    test(`Domain adapter omits missing, blank and invalid request provenance from ${body}`, () => {
        for (const providerRequestId of [undefined, null, '', '   ', '\t\n', 123, {}, []]) {
            const messages = [{ role: 'assistant', content: 'Answer', turnId: 'turn-1', providerRequestId }];
            const conversation = { ...base, ...(body === 'messages' ? { messages } : { turns: [{ messages }] }) };
            const original = structuredClone(conversation);
            const domain = historicalFixtureDomain(conversation);
            assertDomainMessages(domain.detail.messages, [{ role: 'assistant', content: 'Answer' }]);
            assert.equal('provenance' in domain.detail.messages[0], false);
            assert.deepEqual(conversation, original);
        }
        const messages = [{ role: 'user', content: 'No request ID' }];
        const conversation = { ...base, ...(body === 'messages' ? { messages } : { turns: [{ messages }] }) };
        assert.equal('provenance' in historicalFixtureDomain(conversation).detail.messages[0], false);
    });
}

test('Domain adapter does not synthesize message provenance from raw turns or generated media', async () => {
    const generation = { chatId: base.id, generationOrdinal: 1, providerRequestId: 'r_MEDIA', turnId: 'media-turn' };
    const attachment = { type: 'image', url: 'https://example.test/image.png', providerRequestId: 'r_ATTACHMENT', generation };
    const conversation = { ...base, turns: [{ id: 'raw-turn', providerRequestId: 'r_RAW', userContent: 'Question', modelContent: 'Answer', attachments: [attachment] }] };
    const original = structuredClone(conversation);
    const domain = historicalFixtureDomain(conversation);
    assertDomainMessages(domain.detail.messages, [
        { role: 'user', content: 'Question' },
        { role: 'assistant', content: 'Answer', attachments: [attachment] },
    ]);
    assert.deepEqual(conversation, original);
    await assertExportEquivalent(conversation);
});

for (const role of ['model', 'assistant']) {
    for (const body of ['messages', 'turns'] as const) {
        test(`Domain normalizes Gemini/OpenAI reasoning from ${role} ${body}`, async () => {
            const cases = [
                { fields: { thoughts: '  Step one\n正文  ' }, expected: '  Step one\n正文  ' },
                { fields: { thoughts: [' First ', 'Second\nline'] }, expected: ' First \n\nSecond\nline' },
                { fields: { thinking: '  OpenAI reasoning  ' }, expected: '  OpenAI reasoning  ' },
                { fields: { thoughts: 'Preferred', thinking: 'Fallback' }, expected: 'Preferred' },
                { fields: { thoughts: ['Preferred', 'Next'], thinking: 'Fallback' }, expected: 'Preferred\n\nNext' },
                { fields: {}, expected: undefined },
                { fields: { thoughts: '' }, expected: undefined },
                { fields: { thoughts: [] }, expected: undefined },
                { fields: { thoughts: [' ', '\t'] }, expected: undefined },
                { fields: { thinking: ' \n ' }, expected: undefined },
                { fields: { thoughts: '  ', thinking: 'Fallback' }, expected: undefined },
                { fields: { thoughts: '', thinking: 'Fallback' }, expected: undefined },
            ];
            for (const { fields, expected } of cases) {
                const messages = [{ role, content: 'Answer', ...fields }];
                const legacy = { ...base, ...(body === 'messages' ? { messages } : { turns: [{ messages }] }) };
                const original = structuredClone(legacy);
                const domain = historicalFixtureDomain(legacy);
                assert.deepEqual(domain.detail.messages[0].reasoning, expected === undefined ? undefined : expected.split(/\n\n+/).flatMap(plainContent));
                assert.equal('reasoning' in domain.detail.messages[0], expected !== undefined);
                for (const alias of ['thoughts', 'thinking', 'sources']) assert.equal(alias in domain.detail.messages[0], false);
                assert.deepEqual(legacy, original);
                const before = await composeFixture(historicalFixture(legacy, { providerId: 'gemini' }).conversation);
                const after = await composeFixture(domain);
                const thoughts = (result: typeof after) => result.document.messages[0].blocks.filter((block: { type: string }) => block.type === 'disclosure');
                assert.deepEqual(thoughts(after), thoughts(before));
                assert.equal(thoughts(after).length, expected === undefined ? 0 : 1);
            }
        });
    }
}

for (const body of ['messages', 'turns', 'raw-turn'] as const) {
    test(`Domain merges citations and usable sources from ${body}`, async () => {
        const primary = { url: 'https://example.com', title: 'Authoritative' };
        const secondary = { url: 'https://other.example.com', title: 'Other' };
        const cases = [
            { fields: { citations: [primary] }, expected: [primary] },
            { fields: { sources: ['https://example.com', secondary, { url: 'https://third.example.com' }] }, expected: [{ url: 'https://example.com' }, secondary, { url: 'https://third.example.com' }] },
            { fields: { citations: [primary], sources: [secondary] }, expected: [primary, secondary] },
            { fields: { citations: [primary, { ...primary, title: 'Duplicate' }], sources: [{ ...primary, title: 'Legacy' }, primary.url, secondary, secondary] }, expected: [primary, secondary] },
            { fields: { sources: [null, 42, {}, { title: 'No URL' }, { url: 42 }, '', '  ', { url: '' }, { url: '\t' }, ['https://example.com']] }, expected: undefined },
            { fields: { sources: [{ url: primary.url, title: 42 }] }, expected: [{ url: primary.url }] },
            { fields: { citations: [{ url: primary.url }], sources: [primary] }, expected: [{ url: primary.url }] },
        ];
        for (const { fields, expected } of cases) {
            // Raw legacy turns have sources but no citations field in their schema.
            if (body === 'raw-turn' && 'citations' in fields) continue;
            const messages = [{ role: 'model', content: 'Answer [1]', ...fields }];
            const legacy = { ...base, ...(body === 'messages' ? { messages } : body === 'turns' ? { turns: [{ messages }] } : { turns: [{ modelContent: 'Answer [1]', ...fields }] }) };
            const original = structuredClone(legacy);
            const domain = historicalFixtureDomain(legacy);
            assert.deepEqual(domain.detail.messages[0].citations, expected?.map((citation, index) => ({ ...citation, id: `citation-${index}` })));
            assert.equal('sources' in domain.detail.messages[0], false);
            assert.deepEqual(legacy, original);
            if (expected) {
                assert.notEqual(domain.detail.messages[0].citations, expected);
                const canonical = await composeFixture(domain);
                assert.deepEqual(canonical.document.messages[0].sources.map((source: { href: string; label: string }, index: number) => ({ url: source.href, ...('title' in expected[index] ? { title: source.label } : {}) })), expected);
            }
        }
    });
}

test('source validation rejects reasoning/citation aliases before document composition', async () => {
    const clean = { index: { key: fixtureKey(String(base.id), 'gemini'),   titleSource: "derived",  title: base.title,  }, detail: { key: fixtureKey(String(base.id), 'gemini'), quality: { status: 'unknown' }, assets: [], messages: [{ role: 'assistant', content: plainContent('Answer [1]'), reasoning: plainContent('Domain reasoning'), citations: [{ id: 'citation-0', url: 'https://example.com', title: 'Domain citation' }] }] } };
    const leaked = { index: { ...clean.index }, detail: {   ...clean.detail, messages: [{ ...clean.detail.messages[0], thoughts: 'Wrong thoughts', thinking: 'Wrong thinking', sources: ['https://wrong.example.com'] }] } };
    await assert.rejects(composeFixture(leaked), /Invalid persisted Domain contract: messages/);
    const document = (await composeFixture(clean)).document;
    assert.equal(document.messages[0].blocks[0].type, 'disclosure');
    assert.equal(document.messages[0].sources[0].href, 'https://example.com');
    const absent = { index: { key: fixtureKey(String(base.id), 'gemini'),   titleSource: "derived",  title: base.title,  }, detail: { key: fixtureKey(String(base.id), 'gemini'), quality: { status: 'unknown' }, assets: [], messages: [{ role: 'assistant', content: plainContent('Answer') }] } };
    const aliasesOnly = { index: { ...absent.index }, detail: {   ...absent.detail, messages: [{ ...absent.detail.messages[0], thoughts: 'Legacy', thinking: 'Legacy', sources: ['https://wrong.example.com'] }] } };
    await assert.rejects(composeFixture(aliasesOnly), /Invalid persisted Domain contract: messages/);
    assert.equal((await composeFixture(absent)).document.messages[0].blocks.some((block: { type: string }) => block.type === 'disclosure'), false);
});
