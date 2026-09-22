export {};
const test = require('node:test');
const assert = require('node:assert');

const {
    extractChatGPTAssetReferences,
    extractChatGPTGptFileReferences,
    findSignedAssetUrl,
    redactChatGPTAssetMetadata,
    validateEphemeralSignedAssetUrl,
    resolveChatGPTAsset
} = require('../src/core/provider/chatgpt/assets.js');
const { ChatGPTClient } = require('../src/core/provider/chatgpt/client.js');

test('ChatGPT assets - deduplicates same file across pointer attachment citation and file_id evidence', () => {
    const raw = {
        mapping: {
            n1: {
                message: {
                    content: {
                        parts: [{
                            content_type: 'image_asset_pointer',
                            asset_pointer: 'file-service://file-image-1'
                        }]
                    },
                    metadata: {
                        attachments: [{
                            id: 'file-image-1',
                            name: 'photo.png',
                            mime_type: 'image/png'
                        }],
                        citations: [{
                            metadata: {
                                file_id: 'file-image-1',
                                title: 'Referenced image'
                            }
                        }]
                    }
                }
            }
        },
        extra: {
            file_id: 'file-image-1',
            file_name: 'photo.png',
            mime_type: 'image/png'
        }
    };

    const refs = extractChatGPTAssetReferences(raw);
    assert.strictEqual(refs.length, 1);
    assert.strictEqual(refs[0].fileId, 'file-image-1');
    assert.strictEqual(refs[0].preferredName, 'photo.png');
    assert.strictEqual(refs[0].mimeType, 'image/png');
    assert.deepStrictEqual(
        [...refs[0].sources].sort(),
        ['asset_pointer', 'attachment', 'citation', 'file_id'].sort()
    );
});

test('ChatGPT assets - keeps distinct same-name files distinct by strong file id', () => {
    const raw = {
        attachments: [
            { id: 'file-a', name: 'image.png' },
            { id: 'file-b', name: 'image.png' }
        ]
    };
    const refs = extractChatGPTAssetReferences(raw);
    assert.deepStrictEqual(refs.map((x: any) => x.fileId), ['file-a', 'file-b']);
    assert.deepStrictEqual(refs.map((x: any) => x.preferredName), ['image.png', 'image.png']);
});

test('ChatGPT assets - GPT descriptors deduplicate file ids recursively', () => {
    const raw = {
        files: [
            { file_id: 'file-one', name: 'one.pdf', mime_type: 'application/pdf' },
            'file-two',
            {
                nested: [
                    { file_id: 'file-one', name: 'duplicate.pdf' },
                    { file_id: 'file-three', file_name: 'three.txt' }
                ]
            }
        ]
    };
    const refs = extractChatGPTGptFileReferences(raw);
    assert.deepStrictEqual(refs.map((x: any) => x.fileId), ['file-one', 'file-three', 'file-two']);
    assert.strictEqual(refs.find((x: any) => x.fileId === 'file-one').preferredName, 'one.pdf');
});

test('ChatGPT assets - signed URL selection prefers explicit download/signed fields over generic url', () => {
    const meta = {
        url: 'https://chatgpt.com/some-metadata-page',
        nested: {
            signed_url: 'https://cdn.example.com/private/object?sig=secret'
        },
        download_url: 'https://files.example.com/direct?token=secret'
    };
    assert.strictEqual(
        findSignedAssetUrl(meta),
        'https://files.example.com/direct?token=secret'
    );

    const nestedOnly = {
        url: 'not-https',
        nested: {
            signed_url: 'https://cdn.example.com/private/object?sig=secret'
        }
    };
    assert.strictEqual(
        findSignedAssetUrl(nestedOnly),
        'https://cdn.example.com/private/object?sig=secret'
    );
});

test('ChatGPT assets - persistent resolver metadata deeply redacts signed URL-shaped fields without mutating input', () => {
    const original = {
        download_url: 'https://cdn.example.com/a?sig=1',
        nested: {
            signed_url: 'https://cdn.example.com/b?sig=2',
            safe: 'keep-me'
        },
        list: [{
            url: 'https://cdn.example.com/c?sig=3'
        }]
    };
    const redacted = redactChatGPTAssetMetadata(original);

    assert.strictEqual(redacted.download_url, '[REDACTED_SIGNED_URL]');
    assert.strictEqual(redacted.nested.signed_url, '[REDACTED_SIGNED_URL]');
    assert.strictEqual(redacted.list[0].url, '[REDACTED_SIGNED_URL]');
    assert.strictEqual(redacted.nested.safe, 'keep-me');
    assert.strictEqual(original.download_url, 'https://cdn.example.com/a?sig=1');
});

test('ChatGPT assets - signed URL validation rejects local/private/reserved and malformed targets', () => {
    for (const bad of [
        'http://cdn.example.com/file',
        'https://user:pass@cdn.example.com/file',
        'https://127.0.0.1/file',
        'https://10.1.2.3/file',
        'https://192.168.1.2/file',
        'https://[::1]/file',
        'https://cdn.example.com:8443/file'
    ]) {
        assert.throws(() => validateEphemeralSignedAssetUrl(bad));
    }
    const good = validateEphemeralSignedAssetUrl('https://cdn.example.com/file?sig=x');
    assert.strictEqual(good.hostname, 'cdn.example.com');
});

test('ChatGPT assets - resolver returns ephemeral signed URL but only redacted metadata for persistence', async () => {
    const client = {
        resolveFile: async (fileId: string, workspaceId: string, context: any) => {
            assert.strictEqual(fileId, 'file-abc');
            assert.strictEqual(workspaceId, 'raw-workspace-id');
            assert.deepStrictEqual(context, { conversationId: 'conv-1' });
            return {
                signed_url: 'https://cdn.example.com/object?sig=very-secret',
                nested: {
                    url: 'https://cdn.example.com/other?sig=also-secret',
                    content_type: 'image/png'
                }
            };
        }
    };

    const result = await resolveChatGPTAsset(
        client as any,
        'raw-workspace-id',
        {
            fileId: 'file-abc',
            preferredName: 'photo.png',
            sources: ['attachment']
        },
        { conversationId: 'conv-1' }
    );

    assert.strictEqual(result.signedUrl, 'https://cdn.example.com/object?sig=very-secret');
    assert.strictEqual(result.redactedResolverMetadata.signed_url, '[REDACTED_SIGNED_URL]');
    assert.strictEqual(result.redactedResolverMetadata.nested.url, '[REDACTED_SIGNED_URL]');
    assert.ok(!JSON.stringify(result.redactedResolverMetadata).includes('very-secret'));
    assert.ok(!JSON.stringify(result.redactedResolverMetadata).includes('also-secret'));
});

test('ChatGPT client - file resolver is read-only, context-bound, and project endpoint falls back only on 404/405', async () => {
    const calls: Array<{ path: string; workspace?: string }> = [];
    let firstProject = true;
    const transport = {
        requestJson: async (path: string, workspace?: string) => {
            calls.push({ path, workspace });
            if (path.startsWith('/backend-api/files/download/file-project') && firstProject) {
                firstProject = false;
                const error: any = new Error('not found');
                error.status = 404;
                throw error;
            }
            return { ok: true };
        }
    };

    const client = new ChatGPTClient(transport as any);

    await client.resolveFile('file-conv', 'workspace-1', { conversationId: 'conv-1' });
    await client.resolveFile('file-project', 'workspace-1', { projectId: 'g-p-1' });

    assert.strictEqual(calls[0].workspace, 'workspace-1');
    assert.ok(calls[0].path.includes('/backend-api/files/download/file-conv?'));
    assert.ok(calls[0].path.includes('conversation_id=conv-1'));
    assert.ok(calls[0].path.includes('inline=false'));

    assert.ok(calls[1].path.startsWith('/backend-api/files/download/file-project?'));
    assert.ok(calls[1].path.includes('gizmo_id=g-p-1'));
    assert.ok(calls[2].path.startsWith('/backend-api/files/file-project/download?'));

    await assert.rejects(
        () => client.resolveFile('file-x', 'workspace-1', {}),
        /Exactly one conversationId or projectId/
    );
    await assert.rejects(
        () => client.resolveFile('file-x', 'workspace-1', { conversationId: 'c', projectId: 'p' }),
        /Exactly one conversationId or projectId/
    );
});
