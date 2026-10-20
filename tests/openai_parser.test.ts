export {};
const test = require('node:test');
const assert = require('node:assert');
const OpenAiParser = require('../src/core/engine/takeout/openaiParser.js');

function node(id: string, parent: string | null, message: any, children: string[] = []) {
    return { id, parent, children, message };
}

function msg(role: string, contentType: string, parts: any[], createTime?: number, metadata?: any) {
    const m: any = {
        id: 'msg-' + Math.random().toString(36).slice(2),
        author: { role },
        create_time: createTime,
        content: { content_type: contentType, parts },
    };
    if (metadata) m.metadata = metadata;
    return m;
}

async function buildZip(conversations: any[], extraFiles?: Record<string, any>) {
    (global as any).JSZip = require('../lib/jszip.min.js');
    const zip = new (global as any).JSZip();
    zip.file('conversations.json', JSON.stringify(conversations));
    if (extraFiles) {
        for (const [name, content] of Object.entries(extraFiles)) {
            zip.file(name, content as any);
        }
    }
    return zip.generateAsync({ type: 'nodebuffer' });
}

function convA() {
    // user -> thoughts -> assistant, user message carries one image attachment
    const mapping: Record<string, any> = {};
    mapping['n1'] = node('n1', null,
        msg('user', 'text', ['hello'], 1700000000, {
            attachments: [{ id: 'file-abc123', name: 'image.png', mime_type: 'image/png', size: 1234 }],
        }), ['n2']);
    mapping['n2'] = node('n2', 'n1', {
        id: 'msg-thoughts-1',
        author: { role: 'assistant' },
        create_time: 1700000001,
        // real export shape: thinking lives in content.thoughts, not content.parts
        content: { content_type: 'thoughts', thoughts: [{ content: '', summary: 'thinking...' }] },
    }, ['n3']);
    mapping['n3'] = node('n3', 'n2', msg('assistant', 'text', ['hi there'], 1700000002), []);
    return {
        id: 'conv-aaa-111',
        title: 'greeting chat',
        create_time: 1700000000,
        update_time: 1700000010.5,
        current_node: 'n3',
        mapping,
    };
}

function convB() {
    // system + user + assistant, update_time missing -> timestamp must be null, never fabricated
    const mapping: Record<string, any> = {};
    mapping['m1'] = node('m1', null, msg('system', 'text', ['sys prompt'], 1700000100), ['m2']);
    mapping['m2'] = node('m2', 'm1', msg('user', 'text', ['q?'], 1700000101), ['m3']);
    mapping['m3'] = node('m3', 'm2', msg('assistant', 'text', ['a!'], 1700000102), []);
    return {
        id: 'conv-bbb-222',
        title: '',
        create_time: 1700000100,
        current_node: 'm3',
        mapping,
    };
}

test('openai_parser - module exports parseOpenAiZip', () => {
    assert.strictEqual(typeof OpenAiParser.parseOpenAiZip, 'function');
});

test('openai_parser - parses conversations, folds thoughts, resolves attachments', async () => {
    const zipBuffer = await buildZip([convA(), convB()], {
        'conversation_asset_file_names.json': JSON.stringify({ 'file-abc123.dat': 'image.png' }),
        'file-abc123.dat': Buffer.from('PNGDATA'),
    });

    const seen: Array<[number, string]> = [];
    const result = await OpenAiParser.parseOpenAiZip(zipBuffer, (pct: number, m: string) => { seen.push([pct, m]); });

    assert.strictEqual(result.conversations.length, 2);
    assert.strictEqual(result.totalMediaCount, 1);
    assert.ok(seen.some(([p]) => p === 100), 'progress must reach 100');

    const a = result.conversations.find((c: any) => c.id === 'conv-aaa-111');
    assert.ok(a, 'conv A present');
    assert.strictEqual(a.title, 'greeting chat');
    assert.strictEqual(a.titleSource, 'openai');
    assert.strictEqual(a.titles.openai, 'greeting chat');
    assert.strictEqual(a.source, 'openai-import');
    assert.strictEqual(a.url, 'https://chatgpt.com/c/conv-aaa-111');
    assert.strictEqual(a.timestamp, 1700000010500);

    // thoughts node folded into the assistant message, not a separate message
    assert.strictEqual(a.messages.length, 2);
    assert.strictEqual(a.messages[0].role, 'user');
    assert.strictEqual(a.messages[0].content, 'hello');
    assert.strictEqual(a.messages[0].timestamp, 1700000000000);
    assert.strictEqual(a.messages[1].role, 'assistant');
    assert.strictEqual(a.messages[1].content, 'hi there');
    assert.strictEqual(a.messages[1].thoughts, 'thinking...');

    // attachment resolved against the zip entry
    const atts = a.messages[0].attachments;
    assert.strictEqual(atts.length, 1);
    assert.strictEqual(atts[0].type, 'image');
    assert.strictEqual(atts[0].fileName, 'image.png');
    assert.strictEqual(atts[0].localName, 'file-abc123.dat');
    assert.strictEqual(atts[0].mimeType, 'image/png');

    const media = result.mediaMap['conv-aaa-111'];
    assert.ok(Array.isArray(media) && media.length === 1, 'per-conversation media indexed');
    assert.strictEqual(media[0].filename, 'file-abc123.dat');
    const bin = await media[0].fileObj.async('uint8array');
    assert.strictEqual(Buffer.from(bin).toString(), 'PNGDATA');

    assert.ok(result.convCache['conv-aaa-111'], 'convCache populated');
    assert.ok(result.globalMedia['file-abc123.dat'], 'globalMedia has dat entry');
    assert.ok(result.globalMedia['image.png'], 'globalMedia has asset-name alias');

    const b = result.conversations.find((c: any) => c.id === 'conv-bbb-222');
    assert.ok(b, 'conv B present');
    assert.strictEqual(b.title, 'Untitled chat');
    assert.strictEqual(b.timestamp, null, 'missing update_time must stay null, never Date.now()');
    assert.strictEqual(b.messages.length, 3);
    assert.strictEqual(b.messages[0].role, 'system');
    assert.strictEqual(b.messages[2].content, 'a!');
});

test('openai_parser - rejects zip without conversations.json', async () => {
    (global as any).JSZip = require('../lib/jszip.min.js');
    const zip = new (global as any).JSZip();
    zip.file('chat.html', '<html></html>');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    let err: any = null;
    try {
        await OpenAiParser.parseOpenAiZip(buf);
    } catch (e) {
        err = e;
    }
    assert.ok(err, 'must throw');
    assert.ok(String(err.message).includes('conversations.json'), 'error names the missing file');
});

test('openai_parser - multimodal_text with asset_pointer becomes image attachment', async () => {
    const mapping: Record<string, any> = {};
    mapping['v1'] = node('v1', null, {
        id: 'msg-v1',
        author: { role: 'user' },
        create_time: 1700000300,
        content: {
            content_type: 'multimodal_text',
            parts: [
                { content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-img999', width: 100, height: 100 },
                'describe this',
            ],
        },
    }, ['v2']);
    mapping['v2'] = node('v2', 'v1', msg('assistant', 'text', ['a cat'], 1700000301), []);
    const zipBuffer = await buildZip([{
        id: 'conv-ddd-444', title: 'vision', create_time: 1700000300,
        update_time: 1700000302, current_node: 'v2', mapping,
    }], {
        'conversation_asset_file_names.json': JSON.stringify({ 'file-img999.dat': 'cat.png' }),
        'file-img999.dat': Buffer.from('CATPNG'),
    });
    const result = await OpenAiParser.parseOpenAiZip(zipBuffer);
    const c = result.conversations[0];
    assert.strictEqual(c.messages.length, 2);
    assert.strictEqual(c.messages[0].content, 'describe this');
    const atts = c.messages[0].attachments;
    assert.strictEqual(atts.length, 1);
    assert.strictEqual(atts[0].type, 'image');
    assert.strictEqual(atts[0].fileName, 'cat.png');
    assert.strictEqual(atts[0].localName, 'file-img999.dat');
    const media = result.mediaMap['conv-ddd-444'];
    assert.ok(Array.isArray(media) && media.length === 1);
    assert.strictEqual(Buffer.from(await media[0].fileObj.async('uint8array')).toString(), 'CATPNG');
});

test('openai_parser - skips tool nodes and keeps message order oldest-first', async () => {
    const mapping: Record<string, any> = {};
    mapping['t1'] = node('t1', null, msg('user', 'text', ['first'], 1700000200), ['t2']);
    mapping['t2'] = node('t2', 't1', msg('tool', 'text', ['tool output'], 1700000201), ['t3']);
    mapping['t3'] = node('t3', 't2', msg('assistant', 'text', ['second'], 1700000202), []);
    const zipBuffer = await buildZip([{
        id: 'conv-ccc-333', title: 'tools', create_time: 1700000200,
        update_time: 1700000203, current_node: 't3', mapping,
    }]);
    const result = await OpenAiParser.parseOpenAiZip(zipBuffer);
    const c = result.conversations[0];
    assert.strictEqual(c.messages.length, 2, 'tool node skipped');
    assert.strictEqual(c.messages[0].content, 'first');
    assert.strictEqual(c.messages[1].content, 'second');
});
