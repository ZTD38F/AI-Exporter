import { composeFixture } from './helpers/documentFixture.js';
const { historicalFixture } = require('./helpers/nativeFixture.js');
export {};
const test = require('node:test');
const assert = require('node:assert');
const attachments = require('./helpers/recordFixture/attachments.js');
import { renderDocumentMarkdown } from '../src/l4/format/markdown/renderMarkdown.js';

test('user_file_attachment: itemMatchesFilename correctly identifies valid filenames and rejects URLs', () => {
    // Valid filenames with standard and custom extensions
    assert.strictEqual(attachments.itemMatchesFilename('architecture.md'), true);
    assert.strictEqual(attachments.itemMatchesFilename('payload.json'), true);
    assert.strictEqual(attachments.itemMatchesFilename('script.py'), true);
    assert.strictEqual(attachments.itemMatchesFilename('notes.txt'), true);
    assert.strictEqual(attachments.itemMatchesFilename('data.custom'), true);
    assert.strictEqual(attachments.itemMatchesFilename('random_token_123.dat'), true);

    // Reject URLs with extensions or query params
    assert.strictEqual(attachments.itemMatchesFilename('https://example.com/doc.pdf'), false);
    assert.strictEqual(attachments.itemMatchesFilename('https://contribution.usercontent.google.com/download?c=123&filename=architecture.md'), false);
    assert.strictEqual(attachments.itemMatchesFilename('http://lh3.googleusercontent.com/pic.png'), false);
    assert.strictEqual(attachments.itemMatchesFilename('//cdn.google.com/file.txt'), false);
    assert.strictEqual(attachments.itemMatchesFilename('architecture.md?download=1'), false);
    assert.strictEqual(attachments.itemMatchesFilename('foo/bar.md'), false);
    assert.strictEqual(attachments.itemMatchesFilename(''), false);
});

test('user_file_attachment: extractFileNameFromUrl extracts filenames from query params and paths', () => {
    // URL with query param filename=
    const u1 = 'https://contribution.usercontent.google.com/download?c=CgxiYXJkX3N0b3JhZ2U&filename=architecture.md&opi=103135050';
    assert.strictEqual(attachments.extractFileNameFromUrl(u1), 'architecture.md');

    // URL with URL-encoded query param filename=
    const u2 = 'https://contribution.usercontent.google.com/download?c=123&filename=%E6%9E%B6%E6%9E%84%E8%AE%BE%E8%AE%A1%E6%8A%A5%E5%91%8A.json&opi=456';
    assert.strictEqual(attachments.extractFileNameFromUrl(u2), '架构设计报告.json');

    // Custom extension
    const u3 = 'https://contribution.usercontent.google.com/download?c=456&filename=test_run.custom&foo=bar';
    assert.strictEqual(attachments.extractFileNameFromUrl(u3), 'test_run.custom');

    // Path segment extraction
    const u4 = 'https://drive.google.com/uc?export=download&id=123/sample_data.csv';
    assert.strictEqual(attachments.extractFileNameFromUrl(u4), 'sample_data.csv');
});

test('user_file_attachment: extractUserFiles handles real Gemini payload with Drive thumb and Contribution download URL', () => {
    // The exact structure seen in production:
    // node[0] is Drive thumb (viewer/thumb?ds=...)
    // node[1] is contribution.usercontent.google.com download URL with filename=...
    const downloadUrl = 'https://contribution.usercontent.google.com/download?c=CgxiYXJkX3N0b3JhZ2USTxIMcmVxdWVzdF9kYXRhGj8KMDFhMzNjNWM1NjdkOWMwZDEwMDA2NWJkYWZiODRmMGYxMDI4YTFmZjJlZTNhNmFjYRILEgcQwLPF9o4VGAE&filename=architecture.md&opi=103135050';
    const realTurnUserPayload = [
        [
            "请评估附件中的架构设计报告",
            null,
            null,
            [
                [
                    "https://drive.google.com/viewer/thumb?ds=AAEAbe2jCEW-mock&ck=contribservice&dsmi=unknown&w=400&p=proj",
                    downloadUrl,
                    "file_token_273175"
                ]
            ]
        ]
    ];

    const extracted = attachments.extractUserFiles(realTurnUserPayload);
    assert.strictEqual(extracted.length, 1, 'Should extract exactly 1 user file');

    const f = extracted[0];
    assert.strictEqual(f.fileName, 'architecture.md', 'fileName should be correctly extracted as architecture.md, NOT the full URL');
    assert.strictEqual(f.sourceUrl, downloadUrl, 'download URL must come from the file attachment rather than its thumbnail');
    assert.ok(f.thumbnailUrl && f.thumbnailUrl.includes('drive.google.com/viewer/thumb'), 'thumbnailUrl should store the viewer thumbnail as candidate');
});

test('user_file_attachment: extractUserFiles supports multiple diverse extensions (.json, .txt, .custom)', () => {
    const payload = [
        [
            "请分析这些配置和数据文件",
            [
                [
                    "https://drive.google.com/viewer/thumb?ds=thumb1&w=400",
                    "https://contribution.usercontent.google.com/download?c=1&filename=config.json&opi=1"
                ],
                [
                    "https://drive.google.com/viewer/thumb?ds=thumb2&w=400",
                    "https://contribution.usercontent.google.com/download?c=2&filename=notes.txt&opi=2"
                ],
                [
                    "https://drive.google.com/viewer/thumb?ds=thumb3&w=400",
                    "https://contribution.usercontent.google.com/download?c=3&filename=dataset_random.custom&opi=3"
                ]
            ]
        ]
    ];

    const extracted = attachments.extractUserFiles(payload);
    assert.strictEqual(extracted.length, 3);
    assert.strictEqual(extracted[0].fileName, 'config.json');
    assert.strictEqual(extracted[1].fileName, 'notes.txt');
    assert.strictEqual(extracted[2].fileName, 'dataset_random.custom');
});

test('user_file_attachment: Markdown renderer renders clean attachment link without URL leakage', async () => {
    const mockChat = {
        id: '273175',
        title: 'Gemini 架构设计评估报告',
        url: 'https://gemini.google.com/app/273175',
        timestamp: 1700000000000,
        messages: [
            {
                role: 'user',
                content: '请评估这个架构',
                attachments: [
                    {
                        type: 'file',
                        title: 'architecture.md',
                        localName: 'files/273175_architecture.md',
                        name: 'architecture.md'
                    },
                    {
                        type: 'file',
                        title: 'custom_data.xyz',
                        localName: 'files/273175_custom_data.xyz',
                        name: 'custom_data.xyz'
                    }
                ]
            },
            {
                role: 'model',
                content: '架构评估完成。'
            }
        ]
    };

    const parsed = historicalFixture(mockChat);
    const { document, resources } = await composeFixture(parsed.conversation, parsed.resourceHints);
    const markdown = renderDocumentMarkdown(document, resources);
    assert.ok(markdown.includes('[architecture.md](files/273175_architecture.md)'), 'Must render clean Markdown link for architecture.md');
    assert.ok(markdown.includes('[custom\\_data.xyz](files/273175_custom_data.xyz)'), 'Must render clean Markdown link for custom_data.xyz');
    assert.ok(!markdown.includes('https___contribution'), 'Must NOT contain sanitized URL artifacts in Markdown');
    assert.ok(!markdown.includes('[https://'), 'Must NOT render URL as link title');
});

test('user_file_attachment: Markdown renderer preserves a supplied resource label without inferring one from its destination', async () => {
    const mockChat = {
        id: '273175',
        title: 'Leaked URL Title Test',
        messages: [
            {
                role: 'user',
                content: 'Test message',
                attachments: [
                    {
                        type: 'file',
                        title: 'https://contribution.usercontent.google.com/download?c=123&filename=leaked.json',
                        localName: 'files/273175_leaked.json'
                    }
                ]
            }
        ]
    };

    const parsed = historicalFixture(mockChat);
    const { document, resources } = await composeFixture(parsed.conversation, parsed.resourceHints);
    const markdown = renderDocumentMarkdown(document, resources);
    assert.ok(markdown.includes('[https://contribution.usercontent.google.com/download?c=123&amp;filename=leaked.json]'),
        'Composer preserves a supplied nonempty source name; it cannot reinterpret it as missing');
    assert.ok(markdown.includes('files/273175_leaked.json'), 'Must keep localName path');
    assert.ok(!markdown.includes('[leaked.json]'), 'Destination basename cannot replace a supplied source label');
});


test('prompt URLs and Google Docs editor links are not downloadable attachments', () => {
    assert.deepStrictEqual(attachments.extractUserFiles([
        ['https://docs.google.com/document/d/example/edit?tab=t.0 这个是我drive里面的文档，你能编辑么'],
        ['https://docs.google.com/document/d/example/edit'],
        ['https://drive.google.com/file/d/example/view 请帮我读一下']
    ]), []);
});


test('shopping and lmdx widget references are not downloadable image files', () => {
    const shopping = 'http://googleusercontent.com/shopping_content/11889587029331890754';
    const widget = 'http://googleusercontent.com/lmdx_image/894535722';
    assert.deepStrictEqual(attachments.extractImages([[shopping, 640, 480], [widget, 700, 280]]), []);
    assert.deepStrictEqual(attachments.extractUserFiles([[shopping], [widget]]), []);
    const images = attachments.extractImages([['https://encrypted-tbn0.gstatic.com/images?q=real', 700, 280]]);
    assert.equal(images.length, 1);
    assert.equal(images[0].sourceEvidence.detectorKind, 'extractImages [url,w,h]');
});
