import type { Diagnostic } from '../src/shared/diagnostics/diagnostic.js';
import { ResourceHttpError } from '../src/shared/resources/resourceResult.js';
import { chatGPTSandboxLocator, readChatGPTSandboxLocator } from '../src/l1/resources/chatgptSandbox.js';
import { parseOpenAIConversation } from '../src/l1/parsers/chatgpt/parseExportConversation.js';
import { assertDomainClosure } from '../src/l2/closure.js';
import { decodeChatGPTDetail } from '../src/l1/parsers/chatgpt/decodeDetail.js';
import { chatGPTInteractiveSnapshot } from '../src/l1/parsers/chatgpt/interactiveSnapshot.js';
import { getOrCreateAccount } from '../src/runtime/api/accountRegistry.js';
import { listIndexes as getConversations } from '../src/l3a/storageService.js';
import { getDetail } from '../src/l3a/storageService.js';
import { storageIdentity } from './helpers/admitFixture.js';
import { useIndexStorage } from './helpers/indexStorage.js';
useIndexStorage();
import { fixtureAccount } from './helpers/domainFixture.js';
import test from 'node:test';
import katex from 'katex';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    extractChatGPTLinearNodes,
    chatGPTNodeSegments,
    processChatGPTMapping,
    shouldSkipChatGPTMessage,
} from '../src/l1/parsers/chatgpt/conversationTree.js';
import {
    buildAttachmentDownloadPath,
    buildFileDownloadPath,
    fileIdFromPointer,
    parseFileDownloadPayload,
} from '../src/l1/client/chatgpt/imageAssets.js';
import {
    citationsOfChatGPTNode,
    collectChatGPTThinking,
    uploadedFilesOfChatGPTNode,
} from '../src/l1/parsers/chatgpt/conversationDetail.js';
import { parseChatGPTConversation } from '../src/l1/parsers/chatgpt/parseConversation.js';
import { preprocessChatGPTMarkdown } from '../src/l1/parsers/chatgpt/markdownCompatibility.js';
import {
    ensureChatGPTRegistered,
    hasChatGPTAccess,
} from '../src/l1/client/chatgpt/chatgptAccess.js';
import { requestPlatformsAccess } from '../src/l1/client/platformAccess.js';
import { ChatGPTProvider } from '../src/l1/client/chatgpt/chatgptProvider.js';
import { listGen as chatgptListGen } from './fixtures/providers/chatgpt.js';
import { sessionGen as chatgptSessionGen } from './fixtures/providers/chatgptSession.js';
import { detailGen as chatgptDetailGen } from './fixtures/providers/chatgptDetail.js';
import { fileDownloadGen } from './fixtures/providers/chatgptFileDownload.js';
import { signedAssetGen } from './fixtures/providers/chatgptSignedAsset.js';
import { ProviderRegistry } from '../src/l1/client/providerRegistry.js';
import type {
    ChatGPTApiConversationWithId,
    ChatGPTConversationNode,
} from '../src/l1/parsers/chatgpt/chatgptTypes.js';

function textNode(
    id: string,
    parent: string | undefined,
    role: 'user' | 'assistant' | 'system' | 'tool',
    text: string,
    extra?: Partial<ChatGPTConversationNode>,
): ChatGPTConversationNode {
    return {
        id,
        parent,
        children: [],
        message: {
            author: { role },
            content: { content_type: 'text', parts: [text] },
            id: `msg-${id}`,
            recipient: 'all',
            status: 'finished_successfully',
            weight: 1,
        },
        ...extra,
    };
}

test('system and empty assistant turns are skipped, user turns kept in order', () => {
    const mapping: Record<string, ChatGPTConversationNode> = {
        root: { id: 'root', children: ['a'] },
        a: textNode('a', 'root', 'system', 'sys'),
        b: textNode('b', 'a', 'user', 'hello'),
        c: textNode('c', 'b', 'assistant', '  '),
        d: textNode('d', 'c', 'assistant', 'world'),
    };
    mapping.root.children = ['a'];
    mapping.a.children = ['b'];
    mapping.b.children = ['c'];
    mapping.c.children = ['d'];
    mapping.d.children = [];
    const linear = extractChatGPTLinearNodes(new Map(Object.entries(mapping)), 'd');
    assert.deepEqual(linear.map((n) => n.id), ['b', 'd']);
    assert.equal(shouldSkipChatGPTMessage(mapping.c.message), true);
});

test('missing ChatGPT ancestors and cyclic mappings never claim complete Detail or loop', () => {
    const root = { id: 'root', children: ['a'] } as ChatGPTConversationNode;
    const broken: Record<string, ChatGPTConversationNode> = {
        root, a: textNode('a', 'missing', 'user', 'known body'),
    };
    const cyclic: Record<string, ChatGPTConversationNode> = {
        a: textNode('a', 'b', 'user', 'question'),
        b: textNode('b', 'a', 'assistant', 'answer'),
    };
    for (const mapping of [broken, cyclic]) {
        const parsed = parseChatGPTConversation({
            conversation: { id: 'conv-partial', title: 'Partial', createdAtMs: 1000, updatedAtMs: 2000,
                current_node: 'a', mapping: new Map(Object.entries(mapping)), is_archived: false },
            assetsByNode: new Map(),
        });
        assert.equal(parsed.conversation.detail.quality.status, 'partial');
    }
});

test('streaming and interrupted replies preserve complete available snapshots separately from termination', () => {
    for (const patch of [{ status: 'in_progress' }, { status: 'interrupted' }, { end_turn: false }]) {
        const leaf = textNode('a', 'root', 'assistant', 'unfinished body');
        Object.assign(leaf.message!, patch);
        const parsed = parseChatGPTConversation({ conversation: { id: 'streaming', current_node: 'a',
            mapping: new Map(Object.entries<ChatGPTConversationNode>({ root: { id: 'root', parent: null, children: ['a'] } as unknown as ChatGPTConversationNode, a: leaf })),
            title: 'Streaming', createdAtMs: 1000, updatedAtMs: 2000, is_archived: false }, assetsByNode: new Map() });
        assert.equal(parsed.conversation.detail.quality.status, 'complete');
        assert.equal(parsed.conversation.detail.quality.sourceTurn, patch.status === 'interrupted' ? 'interrupted' : 'unfinished');
        assert.match(JSON.stringify(parsed.conversation.detail.messages), /unfinished body/);
    }
});

test('processChatGPTMapping walks from current_node to root', () => {
    const conversation: ChatGPTApiConversationWithId = {
        id: 'conv-1',
        title: 'demo',
        createdAtMs: 1700000000000,
        updatedAtMs: 1700000600000,
        current_node: 'e',
        is_archived: false,
        mapping: new Map(Object.entries<ChatGPTConversationNode>({
            root: { id: 'root', children: ['b'] },
            b: textNode('b', 'root', 'user', 'hi', { children: ['d'] }),
            d: textNode('d', 'b', 'assistant', 'hello there', { children: ['e'] }),
            e: textNode('e', 'd', 'assistant', 'follow up'),
        })),
    };
    const nodes = processChatGPTMapping(conversation);
    assert.deepEqual(nodes.map((n) => n.id), ['b', 'd', 'e']);
});

test('ChatGPTProvider matches only chatgpt hostnames', () => {
    const provider = new ChatGPTProvider({ fetchFn: () => Promise.reject(new Error('no-net')) });
    assert.equal(provider.matchesUrl('https://chatgpt.com/c/abc'), true);
    assert.equal(provider.matchesUrl('https://chat.openai.com/c/abc'), true);
    assert.equal(provider.matchesUrl('https://gemini.google.com/app'), false);
});

test('ChatGPTProvider checkReadiness reports logged-out session', async () => {
    let seenCredentials: RequestCredentials | undefined;
    const provider = new ChatGPTProvider({
        fetchFn: (_url, init) => {
            seenCredentials = init?.credentials;
            return Promise.resolve(
                new Response(JSON.stringify(chatgptSessionGen('C_PROVIDER_CHATGPT_TREE_READINESS_01')), { status: 200 }),
            );
        },
    });
    const readiness = await provider.checkReadiness(fixtureAccount('chatgpt').id);
    assert.equal(readiness.ready, false);
    assert.equal(seenCredentials, 'include');
});

test('ChatGPTProvider rejects non-string Session tokens before an authorized request', async () => {
    const account = await getOrCreateAccount('chatgpt', JSON.stringify(['invalid-token-user', 'invalid-token-workspace']));
    const requests: string[] = [];
    const provider = new ChatGPTProvider({ fetchFn: async url => {
        requests.push(url);
        return new Response(JSON.stringify(chatgptSessionGen('C_PROVIDER_CHATGPT_TREE_INVALID_TOKEN_01')));
    } });
    assert.equal((await provider.checkReadiness(account.id)).ready, false);
    await assert.rejects(provider.listConversations({ accountId: account.id, streamId: 'recent' }), /has no accessToken/);
    assert.deepEqual(requests, Array(2).fill('https://chatgpt.com/api/auth/session'));
});

test('tool image nodes are kept and their sediment pointers collected', () => {
    const toolImage: ChatGPTConversationNode = {
        id: 't1',
        parent: 'u1',
        children: [],
        message: {
            author: { role: 'tool' },
            content: {
                content_type: 'multimodal_text',
                parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_abc' }],
            },
            id: 'msg-t1',
            recipient: 'all',
            status: 'finished_successfully',
            weight: 1,
        },
    };
    const toolChatter: ChatGPTConversationNode = {
        id: 't2',
        parent: 't1',
        children: [],
        message: {
            author: { role: 'tool', name: 'browser' },
            content: { content_type: 'text', parts: ['searching...'] },
            id: 'msg-t2',
            recipient: 'all',
            status: 'finished_successfully',
            weight: 1,
        },
    };
    assert.equal(shouldSkipChatGPTMessage(toolImage.message), false);
    assert.equal(shouldSkipChatGPTMessage(toolChatter.message), true);
    assert.deepEqual(chatGPTNodeSegments(toolImage), [{ kind: 'image', pointer: 'sediment://file_abc' }]);
});

test('files/download helpers narrow signed-url payloads', () => {
    assert.equal(fileIdFromPointer('sediment://file_abc'), 'file_abc');
    assert.equal(fileIdFromPointer('https://x/y.png'), null);
    assert.equal(fileIdFromPointer('file-service://file-legacy'), 'file-legacy');
    assert.equal(fileIdFromPointer('file-service://'), null);
    const opaque = 'prefix#file_abc#p_0.preview.jpg';
    const scoped = new URL(buildFileDownloadPath(opaque, 'conversation-id'), 'https://chatgpt.com');
    assert.equal(decodeURIComponent(scoped.pathname.split('/').at(-1) ?? ''), opaque.replaceAll('#', '*'));
    assert.equal(scoped.hash, '');
    assert.equal(buildAttachmentDownloadPath('file_abc', 'conversation-id'), '/conversation/conversation-id/attachment/file_abc/download');
    assert.deepEqual(parseFileDownloadPayload({ download_url: 'https://dl/upload.txt' }), { downloadUrl: 'https://dl/upload.txt' });
    assert.equal(parseFileDownloadPayload({ status: 'retry', download_url: 'https://dl/upload.txt' }), null);
    assert.equal(scoped.searchParams.get('conversation_id'), 'conversation-id');
    assert.equal(scoped.searchParams.get('inline'), 'false');
    assert.equal(scoped.searchParams.get('download_intent'), 'true');
    assert.deepEqual(
        parseFileDownloadPayload(fileDownloadGen('C_FILE_DOWNLOAD_HELPERS_01')),
        { downloadUrl: 'https://x/dl', fileName: 'a.png', byteLength: 10 },
    );
    assert.equal(parseFileDownloadPayload(fileDownloadGen('C_FILE_DOWNLOAD_HELPERS_02')), null);
    assert.equal(parseFileDownloadPayload(null), null);
});

test('Detail submits image identities; bytes are acquired on demand without changing body quality', async () => {
    const pngBytes = signedAssetGen('C_SIGNED_ASSET_CAT_PNG_01');
    const provider = new ChatGPTProvider({
        fetchFn: (url) => {
            const u = String(url);
            if (u.endsWith('/api/auth/session')) {
                return Promise.resolve(new Response(JSON.stringify(chatgptSessionGen('C_FILE_DOWNLOAD_SESSION_01')), { status: 200 }));
            }
            if (/\/conversation\/conv-img\/attachment\/file_fallback_(403|404)\/download$/.test(u)) {
                const status = u.includes('file_fallback_403') ? 403 : 404;
                return Promise.resolve(new Response(JSON.stringify(fileDownloadGen('C_FILE_DOWNLOAD_ACQUIRE_02')), { status }));
            }
            if (u.includes('/files/download/file_fallback_')) {
                assert.equal(new URL(u).searchParams.get('conversation_id'), 'conv-img');
                return Promise.resolve(new Response(JSON.stringify(fileDownloadGen('C_FILE_DOWNLOAD_ACQUIRE_01')), { status: 200 }));
            }
            if (u.includes('/conversation/conv-img/interpreter/download')) {
                const query = new URL(u).searchParams;
                assert.equal(query.get('message_id'), 'msg-sandbox');
                assert.equal(query.get('sandbox_path'), '/mnt/data/preview image.png');
                return Promise.resolve(new Response(JSON.stringify(fileDownloadGen('C_ATTACHMENT_DOWNLOAD_ACQUIRE_01')), { status: 200 }));
            }
            if (u.endsWith('/conversation/conv-img/attachment/file_cat/download')) {
                return Promise.resolve(new Response(JSON.stringify(fileDownloadGen('C_ATTACHMENT_DOWNLOAD_ACQUIRE_01')), { status: 200 }));
            }
            if (u.includes('/files/download/file_cat')) {
                assert.equal(new URL(u).searchParams.get('conversation_id'), 'conv-img');
                return Promise.resolve(new Response(JSON.stringify(fileDownloadGen('C_FILE_DOWNLOAD_ACQUIRE_01')), { status: 200 }));
            }
            if (u.includes('/files/download/file_missing')) {
                return Promise.resolve(new Response(JSON.stringify(fileDownloadGen('C_FILE_DOWNLOAD_ACQUIRE_02')), { status: 404 }));
            }
            if (u === 'https://dl/img.png') {
                return Promise.resolve(new Response(pngBytes, {
                    status: 200, headers: { 'content-type': 'image/png' },
                }));
            }
            if (u.includes('/conversation/')) {
                return Promise.resolve(new Response(JSON.stringify(chatgptDetailGen('C_PROVIDER_CHATGPT_TREE_IMAGE_DETAIL_01')), { status: 200 }));
            }
            return Promise.resolve(new Response('nope', { status: 404 }));
        },
    });
    const account = await getOrCreateAccount('chatgpt', 'default');
    assert.equal(await provider.fetchConversationDetail(account.id, 'conv-img'), undefined);
    const stored = await getDetail(storageIdentity('chatgpt', account.id, 'conv-img'));
    assert.ok(stored);
    const detail = stored;
    assert.equal(detail.savedAt, 1700000060000);
    assert.equal((await getConversations(account.id))[0].createdAt, 1700000000000);
    assert.equal(detail.assets.length, 2);
    assert.equal(detail.assets[0].sourceUri, 'sediment://file_cat');
    const key = { accountId: account.id, conversationId: 'conv-img' };
    const downloaded = await provider.acquireResource(key, detail.assets[0]);
    assert.deepEqual(downloaded.bytes, pngBytes);
    assert.equal(downloaded.mediaType, 'image/png');
    assert.equal(downloaded.name, 'cat.png');
    const legacy = { ...detail.assets[0], sourceUri: 'file-service://file_cat' };
    assert.equal(provider.canAcquireResourceDirectly(legacy), true);
    assert.deepEqual((await provider.acquireResource(key, legacy)).bytes, pngBytes);
    const upload = { id: 'uploaded-file', kind: 'file' as const, sourceUri: 'file-download:file_cat' };
    assert.deepEqual((await provider.acquireResource(key, upload)).bytes, pngBytes);
    const generated = { id: 'sandbox-image', kind: 'image' as const, sourceUri: chatGPTSandboxLocator('msg-sandbox', '/mnt/data/preview image.png') };
    assert.equal(provider.canAcquireResourceDirectly(generated), true);
    assert.deepEqual((await provider.acquireResource(key, generated)).bytes, pngBytes);
    for (const status of [403, 404]) {
        const library = { ...upload, id: `library-${status}`, sourceUri: `file-download:file_fallback_${status}` };
        assert.deepEqual((await provider.acquireResource(key, library)).bytes, pngBytes);
    }
    await assert.rejects(provider.acquireResource(key, detail.assets[1]), /404/);
    assert.equal(detail.quality.status, 'complete');
    const after = await getDetail(storageIdentity('chatgpt', account.id, 'conv-img'));
    assert.deepEqual(after?.quality, detail.quality);
    const userMsg = detail.messages.find(m => m.id === 'u1');
    assert.deepEqual(userMsg?.content.map(b => b.type), ['paragraph', 'image', 'paragraph']);
    const toolMsg = detail.messages.find(m => m.id === 't1');
    assert.equal(toolMsg?.attachmentIds, undefined);
    assert.deepEqual(toolMsg?.content.filter(b => b.type === 'image').map(b => b.assetId), [detail.assets[1].id]);

});

test('thinking walk attaches hidden reasoning to the following assistant node', () => {
    const mapping: Record<string, ChatGPTConversationNode> = {
        root: { id: 'root', children: ['u1'] },
        u1: {
            id: 'u1', parent: 'root', children: ['th'],
            message: {
                author: { role: 'user' },
                content: { content_type: 'text', parts: ['q'] },
                id: 'msg-u1', recipient: 'all', status: 'finished_successfully', weight: 1,
            },
        },
        th: {
            id: 'th', parent: 'u1', children: ['rc'],
            message: {
                author: { role: 'assistant' },
                content: { content_type: 'thoughts', thoughts: [{ summary: 'plan', content: 'step by step' }] },
                id: 'msg-th', recipient: 'all', status: 'finished_successfully', weight: 1,
            },
        },
        rc: {
            id: 'rc', parent: 'th', children: ['a1'],
            message: {
                author: { role: 'assistant' },
                content: { content_type: 'reasoning_recap', content: 'Thought for 12 seconds' },
                metadata: { finished_duration_sec: 12 },
                id: 'msg-rc', recipient: 'all', status: 'finished_successfully', weight: 1,
            },
        },
        a1: {
            id: 'a1', parent: 'rc', children: [],
            message: {
                author: { role: 'assistant' },
                content: { content_type: 'text', parts: ['answer'] },
                id: 'msg-a1', recipient: 'all', status: 'finished_successfully', weight: 1,
            },
        },
    };
    const ids = new Set(['u1', 'a1']);
    const got = collectChatGPTThinking(new Map(Object.entries(mapping)), ids, 'a1');
    const thinking = got.get('a1');
    assert.ok(thinking);
    assert.equal(thinking?.thoughts.length, 1);
    assert.equal(thinking?.durationSeconds, 12);
    // Reasoning blocks render through the full parser (markdown included).
    const parsed = parseChatGPTConversation({ account: fixtureAccount('chatgpt'),
        conversation: {
            id: 'conv-think', title: 't', createdAtMs: 1000, updatedAtMs: 2000,
            current_node: 'a1', mapping: new Map(Object.entries(mapping)), is_archived: false,
        },
        assetsByNode: new Map(),
    });
    const assistant = parsed.conversation.detail.messages.find((m) => m.id === 'a1');
    assert.ok(assistant?.reasoning && assistant.reasoning.length >= 2);
    assert.match(JSON.stringify(assistant?.reasoning[0]), /12/);
});

test('dialect preprocessing shields code and normalizes math/citations', () => {
    // Exact marker shapes captured live via 9222 (2026-10-14).
    const cite = '\ue200cite\ue202turn388160search0\ue202turn388160search1\ue201';
    const url = '\ue200url\ue202ChatGPT \u6a21\u578b\ue202https://help.openai.com/en/a\ue201';
    const src = '费用是 $5。公式 \\(x^2\\) 行内。引用' + cite + '结尾。看' + url + '。\n\n\\[y = mx\\]\n\n`代码 \\(不动\\) $10`。<br>换行';
    const out = preprocessChatGPTMarkdown(src);
    assert.match(out, /\$x\^2\$/);
    assert.match(out, /\$\$\ny = mx\n\$\$/);
    assert.ok(out.includes('`代码 \\(不动\\) $10`'));
    assert.ok(!out.includes('cite'));
    assert.ok(!out.includes('turn388160'));
    assert.ok(out.includes('[ChatGPT \u6a21\u578b](https://help.openai.com/en/a)'));
    assert.ok(!out.includes('<br>'));
    assert.ok(out.includes('$5'));
    assert.ok(!/[\ue000-\uf8ff]/.test(out));
});

test('bodies parse to structured blocks and models stay per-message', () => {
    const mapping: Record<string, ChatGPTConversationNode> = {
        root: { id: 'root', children: ['u1'] },
        u1: {
            id: 'u1', parent: 'root', children: ['a1'],
            message: {
                author: { role: 'user' },
                content: { content_type: 'text', parts: ['hi'] },
                id: 'msg-u1', recipient: 'all', status: 'finished_successfully', weight: 1,
                metadata: { model_slug: 'gpt-6' },
            },
        },
        a1: {
            id: 'a1', parent: 'u1', children: [],
            message: {
                author: { role: 'assistant' },
                content: { content_type: 'text', parts: ['# Title\n\n```python\nprint(1)\n```\n\n公式 \\(e=mc^2\\)'] },
                id: 'msg-a1', recipient: 'all', status: 'finished_successfully', weight: 1,
                metadata: { model_slug: 'gpt-6-pro' },
            },
        },
    };
    const parsed = parseChatGPTConversation({ account: fixtureAccount('chatgpt'),
        conversation: {
            id: 'conv-md', title: 't', createdAtMs: 1000, updatedAtMs: 2000,
            current_node: 'a1', mapping: new Map(Object.entries(mapping)), is_archived: false,
        },
        assetsByNode: new Map(),
    });
    assert.equal(parsed.sourceVersion, 2000);
    assert.equal(Object.hasOwn(parsed.conversation, 'updatedAt'), false);
    const kinds = parsed.conversation.detail.messages.find((m) => m.id === 'a1')?.content.map((b) => b.type);
    assert.ok(kinds?.includes('heading'));
    assert.ok(kinds?.includes('code'));
    assert.deepEqual(
        parsed.conversation.detail.messages.map((m) => m.model),
        ['gpt-6', 'gpt-6-pro'],
    );
});

test('repeated image pointers reuse one asset instead of breaking closure', () => {
    const tool = (id: string, parent: string): ChatGPTConversationNode => ({
        id, parent, children: [],
        message: {
            author: { role: 'tool' },
            content: {
                content_type: 'multimodal_text',
                parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_dup' }],
            },
            id: `msg-${id}`, recipient: 'all', status: 'finished_successfully', weight: 1,
        },
    });
    const mapping: Record<string, ChatGPTConversationNode> = {
        root: { id: 'root', children: ['u1'] },
        u1: {
            id: 'u1', parent: 'root', children: ['t1'],
            message: {
                author: { role: 'user' },
                content: { content_type: 'text', parts: ['again'] },
                id: 'msg-u1', recipient: 'all', status: 'finished_successfully', weight: 1,
            },
        },
        t1: { ...tool('t1', 'u1'), children: ['t2'] },
        t2: { ...tool('t2', 't1'), children: [] },
    };
    const img = { pointer: 'sediment://file_dup', assetId: 'img-file_dup', dataBase64: 'aGk=' };
    const parsed = parseChatGPTConversation({ account: fixtureAccount('chatgpt'),
        conversation: {
            id: 'conv-dup', title: 't', createdAtMs: 1000, updatedAtMs: 2000,
            current_node: 't2', mapping: new Map(Object.entries(mapping)), is_archived: false,
        },
        assetsByNode: new Map([
            ['t1', { nodeId: 't1', images: [img], files: [] }],
            ['t2', { nodeId: 't2', images: [img], files: [] }],
        ]),
    });
    assert.equal(parsed.conversation.detail.assets.length, 1);
    assert.deepEqual(
        parsed.conversation.detail.messages.filter((m) => m.id === 't1' || m.id === 't2').map((m) => m.content.filter(b => b.type === 'image').map(b => b.assetId)),
        [['img-file_dup'], ['img-file_dup']],
    );
});

test('citations dedupe by URL across tether and grouped references', () => {
    const node: ChatGPTConversationNode = {
        id: 'a1', children: [],
        message: {
            author: { role: 'assistant' },
            content: { content_type: 'text', parts: ['hi'] },
            id: 'msg-a1', recipient: 'all', status: 'finished_successfully', weight: 1,
            metadata: {
                citations: [{ metadata: { title: 'T', url: 'https://ex.com/a' } }],
                content_references: [{
                    items: [{ title: 'T', url: 'https://ex.com/a' }, { title: 'B', url: 'https://ex.com/b' }],
                }],
            },
        },
    };
    const cites = citationsOfChatGPTNode(node);
    assert.deepEqual(cites.map((c) => c.url), ['https://ex.com/a', 'https://ex.com/b']);
    assert.deepEqual(cites.map((c) => c.id), ['citation-0', 'citation-1']);
});

test('uploaded non-image files recorded, images left to the image path', () => {
    const node: ChatGPTConversationNode = {
        id: 'u1', children: [],
        message: {
            author: { role: 'user' },
            content: { content_type: 'text', parts: ['see files'] },
            id: 'msg-u1', recipient: 'all', status: 'finished_successfully', weight: 1,
            metadata: {
                attachments: [
                    { id: 'file-1', name: 'notes.pdf', mime_type: 'application/pdf', size: 42 },
                    { id: 'file-2', name: 'pic.png', mime_type: 'image/png' },
                ],
            },
        },
    };
    assert.deepEqual(uploadedFilesOfChatGPTNode(node), [
        { id: 'file-1', name: 'notes.pdf', mediaType: 'application/pdf', byteLength: 42 },
    ]);
});

test('listConversations paginates until the reported total is reached', async () => {
    const calls: string[] = [];
    const provider = new ChatGPTProvider({
        fetchFn: (url) => {
            const u = String(url);
            if (u.endsWith('/api/auth/session')) {
                return Promise.resolve(new Response(JSON.stringify(chatgptSessionGen('C_PROVIDER_CHATGPT_TREE_02')), { status: 200 }));
            }
            calls.push(u);
            return Promise.resolve(new Response(JSON.stringify(chatgptListGen('C_PROVIDER_CHATGPT_TREE_03')), { status: 200 }));
        },
    });
    const account = await getOrCreateAccount('chatgpt', JSON.stringify(['u-list', 'workspace-list']));
    assert.equal(await provider.listConversations({ accountId: account.id, streamId: 'recent' }), 'source_end');
    const indexes = await getConversations(account.id);
    assert.deepEqual(indexes.map(i => i.key.conversationId), ['a', 'b', 'c']);
    assert.equal(indexes[0].createdAt, 1000); assert.equal(indexes[0].updatedAt, 2000);
    assert.equal(calls.length, 1);

});

test('ChatGPT current list schema without the legacy missing flag traverses all pages', async () => {
    const account = await getOrCreateAccount('chatgpt', JSON.stringify(['u-list', 'workspace-list']));
    const offsets: number[] = [];
    const committed: Array<{ page: number; total: number; trustedHead: boolean }> = [];
    const provider = new ChatGPTProvider({ fetchFn: async url => {
        if (url.endsWith('/api/auth/session')) return new Response(JSON.stringify(chatgptSessionGen('C_PROVIDER_CHATGPT_TREE_04')));
        const offset = Number(new URL(url).searchParams.get('offset'));
        offsets.push(offset);
        return new Response(JSON.stringify(chatgptListGen(offset === 0 ? 'C_PROVIDER_CHATGPT_TREE_05_0' : 'C_PROVIDER_CHATGPT_TREE_05_100')));
    } });
    assert.equal(await provider.listConversations({
        accountId: account.id, streamId: 'recent',
        onPageCommitted: async page => {
            committed.push({ page: page.page, total: page.totalObserved, trustedHead: !!page.scanHead });
            return false;
        },
    }), 'source_end');
    assert.deepEqual(offsets, [0, 100]);
    assert.deepEqual(committed, [
        { page: 1, total: 100, trustedHead: true },
        { page: 2, total: 102, trustedHead: false },
    ]);
    assert.equal((await getConversations(account.id)).length, 102);
});

test('ChatGPT rolling total traverses beyond 200 rows and requires a proven final page', async () => {
    for (const [endKey, expectedCount] of [
        ['C_PROVIDER_CHATGPT_TREE_ROLLING_END', 203],
        ['C_PROVIDER_CHATGPT_TREE_ROLLING_EMPTY_END', 200],
        ['C_PROVIDER_CHATGPT_TREE_ROLLING_FULL_END', 300],
    ] as const) {
        const account = await getOrCreateAccount('chatgpt', JSON.stringify(['u-list', 'workspace-list']));
        const offsets: number[] = [];
        const provider = new ChatGPTProvider({ fetchFn: async url => {
            if (url.endsWith('/api/auth/session')) return new Response(JSON.stringify(chatgptSessionGen('C_PROVIDER_CHATGPT_TREE_04')));
            const offset = Number(new URL(url).searchParams.get('offset'));
            offsets.push(offset);
            return new Response(JSON.stringify(chatgptListGen(offset === 0
                ? 'C_PROVIDER_CHATGPT_TREE_ROLLING_0' : offset === 100
                    ? 'C_PROVIDER_CHATGPT_TREE_ROLLING_100' : endKey)));
        } });
        const committed: number[] = [];
        assert.equal(await provider.listConversations({ accountId: account.id, streamId: 'recent',
            onPageCommitted: async page => { committed.push(page.totalObserved); return false; },
        }), 'source_end');
        assert.deepEqual(offsets, [0, 100, 200]);
        assert.deepEqual(committed, [100, 200, expectedCount]);
    }
});

test('ChatGPT empty current list schema proves source exhaustion', async () => {
    const account = await getOrCreateAccount('chatgpt', JSON.stringify(['u-list', 'workspace-list']));
    const provider = new ChatGPTProvider({ fetchFn: async url => new Response(JSON.stringify(
        url.endsWith('/api/auth/session')
            ? chatgptSessionGen('C_PROVIDER_CHATGPT_TREE_06')
            : chatgptListGen('C_PROVIDER_CHATGPT_TREE_07'),
    )) });
    assert.equal(await provider.listConversations({ accountId: account.id, streamId: 'recent' }), 'source_end');
    assert.equal((await getConversations(account.id)).length, 0);
});


test('ChatGPT Provider rejects foreign conversation_id and malformed Detail mapping', async () => {
    const account = await getOrCreateAccount('chatgpt', 'default');
    for (const detailKey of [
        'C_PROVIDER_CHATGPT_TREE_INVALID_DETAIL_01',
        'C_PROVIDER_CHATGPT_TREE_INVALID_DETAIL_02',
        'C_PROVIDER_CHATGPT_TREE_INVALID_DETAIL_03',
    ] as const) {
        const provider = new ChatGPTProvider({ fetchFn: url => Promise.resolve(new Response(JSON.stringify(
            String(url).endsWith('/api/auth/session')
                ? chatgptSessionGen('C_PROVIDER_CHATGPT_TREE_INVALID_DETAIL_SESSION_01')
                : chatgptDetailGen(detailKey),
        ), { status: 200 })) });
        await assert.rejects(provider.fetchConversationDetail(account.id, 'requested-conversation'),
            /Detail identity mismatch|Invalid ChatGPT Detail/);
        assert.equal(await getDetail(storageIdentity('chatgpt', account.id, 'requested-conversation')), null);
    }
});

test('ChatGPT Detail never relabels a foreign source conversation ID', async () => {
    const provider = new ChatGPTProvider({ fetchFn: url => Promise.resolve(new Response(JSON.stringify(
        String(url).endsWith('/api/auth/session')
            ? chatgptSessionGen('C_PROVIDER_CHATGPT_TREE_FOREIGN_DETAIL_SESSION_01')
            : chatgptDetailGen('C_PROVIDER_CHATGPT_TREE_FOREIGN_DETAIL_01'),
    ), { status: 200 })) });
    const account = await getOrCreateAccount('chatgpt', 'default');
    await assert.rejects(provider.fetchConversationDetail(account.id, 'requested-conversation'),
        /Detail identity mismatch/);
    assert.equal(await getDetail(storageIdentity('chatgpt', account.id, 'requested-conversation')), null);
});

test('ChatGPT list refuses source_end when pagination, ordering or completeness is unverified', async () => {
    const account = await getOrCreateAccount('chatgpt', JSON.stringify(['u-list', 'workspace-list']));
    // Includes missing-time, legacy missing flag, wrong offset, missing total/limit,
    // and incomplete pages without the legacy flag.
    for (const key of ['C_PROVIDER_CHATGPT_TREE_08_0', 'C_PROVIDER_CHATGPT_TREE_08_1', 'C_PROVIDER_CHATGPT_TREE_08_2', 'C_PROVIDER_CHATGPT_TREE_08_3', 'C_PROVIDER_CHATGPT_TREE_08_4', 'C_PROVIDER_CHATGPT_TREE_08_5', 'C_PROVIDER_CHATGPT_TREE_08_6', 'C_PROVIDER_CHATGPT_TREE_08_7'] as const) {
        const page = chatgptListGen(key);
        const provider = new ChatGPTProvider({ fetchFn: url => Promise.resolve(new Response(JSON.stringify(
            String(url).endsWith('/api/auth/session') ? chatgptSessionGen('C_PROVIDER_CHATGPT_TREE_09') : page,
        ), { status: 200 })) });
        await assert.rejects(provider.listConversations({ accountId: account.id, streamId: 'recent' }),
            /Unverified ChatGPT list page/);
    }
});

test('ChatGPT registry stays inert until the unified platform authorization grants access', async () => {
    const holder = globalThis as unknown as { chrome?: unknown };
    const previous: unknown = holder.chrome;
    try {
        holder.chrome = undefined;
        assert.equal(await hasChatGPTAccess(), false);
        assert.equal(await requestPlatformsAccess(['chatgpt']), false);
        assert.equal(await ensureChatGPTRegistered(), false);
        let granted = false;
        holder.chrome = {
            permissions: {
                contains: () => Promise.resolve(granted),
                request: () => {
                    granted = true;
                    return Promise.resolve(true);
                },
            },
        };
        assert.equal(await hasChatGPTAccess(), false);
        assert.equal(await requestPlatformsAccess(['chatgpt']), true);
        assert.equal(await hasChatGPTAccess(), true);
        assert.equal(await ensureChatGPTRegistered(), true);
    } finally {
        ProviderRegistry.unregister('chatgpt');
        holder.chrome = previous;
    }
});

test('Intelligent UI questionnaires use the provider fallback without executing or exporting component code', () => {
    const raw = '<radio-group value={issue}><radio>Menu unavailable</radio></radio-group>';
    const fallback = 'Which issue?\n\nMenu unavailable\n\nCannot switch\n\nWhich platform?\n\nBrowser\n\nMobile\n\n[Diagnose]';
    const assistant = textNode('answer', 'question', 'assistant', raw);
    assistant.message!.metadata = { model_dil_v2: { fallbackMarkdown: fallback } };
    const conversation: ChatGPTApiConversationWithId = {
        id: 'questionnaire', title: 'Questionnaire', createdAtMs: 1000, updatedAtMs: 2000,
        current_node: 'answer', is_archived: false,
        mapping: new Map(Object.entries<ChatGPTConversationNode>({
            root: { id: 'root', children: ['question'] },
            question: textNode('question', 'root', 'user', 'Help me diagnose'),
            answer: assistant,
        })),
    };
    const parsed = parseChatGPTConversation({ conversation, assetsByNode: new Map() });
    const body = JSON.stringify(parsed.conversation.detail.messages[1].content);
    for (const label of ['Which issue?', 'Menu unavailable', 'Cannot switch', 'Which platform?', 'Browser', 'Mobile', 'Diagnose'])
        assert.ok(body.includes(label), `missing questionnaire label: ${label}`);
    assert.ok(!body.includes('radio-group'));
    assert.ok(!body.includes('value={issue}'));
    assert.equal(assistant.message!.content.content_type, 'text');
    assert.equal((assistant.message!.content as { parts: string[] }).parts[0], raw, 'raw source remains unchanged');
});


test('DIL static-source diagnostics reuse the same snapshot as the rendered branch', () => {
    const source = '<radio-group><radio>First choice</radio><radio>Second choice</radio></radio-group>';
    const answer = textNode('answer', 'question', 'assistant', source);
    answer.message!.metadata = { model_dil_v2: { fallbackMarkdown: 'First choice\nSecond choice' } };
    const conversation: ChatGPTApiConversationWithId = {
        id: 'dil-once', current_node: 'answer', title: '', is_archived: false,
        mapping: new Map(Object.entries<ChatGPTConversationNode>({ root: { id: 'root', children: ['question'] },
            question: textNode('question', 'root', 'user', 'Choose'),
            answer })),
    };
    const expected = chatGPTInteractiveSnapshot(source, 'First choice\nSecond choice');
    const parsed = parseChatGPTConversation({ conversation, assetsByNode: new Map() });
    const diagnostic = parsed.diagnostics.find(item => item.code === 'CHATGPT_INTERACTIVE_STATIC_SNAPSHOT');
    assert.ok(diagnostic, 'source DIL modules must be diagnosed, not reparsed from the rendered body');
    const details = diagnostic.details;
    assert.ok(details && typeof details === 'object' && !Array.isArray(details));
    assert.equal('representation' in details ? details.representation : undefined, expected.representation);
    assert.equal(parsed.conversation.detail.quality.status, expected.incomplete ? 'partial' : 'complete');
    const body = JSON.stringify(parsed.conversation.detail.messages[1].content);
    for (const choice of ['First choice', 'Second choice']) assert.ok(body.includes(choice));
    assert.equal((answer.message!.content as { parts: string[] }).parts[0], source, 'do not mutate input mapping');
});

test('Captured live DIL quiz parses nested questions/options before buttons, without fallback', () => {
    const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures/chatgpt_dynamic_questionnaire.json'), 'utf8')) as {
        raw: string; fallbackMarkdown: string;
    };
    const snapshot = chatGPTInteractiveSnapshot(fixture.raw, fixture.fallbackMarkdown);
    assert.equal(snapshot.representation, 'structured-source');
    assert.equal(snapshot.incomplete, false);
    assert.equal(snapshot.fallbackBlocks, 0);
    const ordered = ['1. 以下哪种垃圾', 'A. 果皮和蔬菜残渣', 'B. 塑料包装袋', 'C. 玻璃碎片',
        '2. 为了让堆肥', 'A. 密封后完全不管', 'B. 适当混合并保持透气', 'C. 不断加入大量清水',
        '3. 怎样判断', 'A. 有强烈刺鼻气味', 'B. 仍能清楚辨认所有新鲜厨余', 'C. 颜色较深',
        '[提交问卷]', '[清空重答]', 'COMPOST-END'];
    let at = -1;
    for (const token of ordered) { const next = snapshot.text.indexOf(token); assert.ok(next > at, token); at = next; }
    assert.equal(chatGPTInteractiveSnapshot(fixture.raw).text, snapshot.text, 'fallback is not required to parse this component');
    for (const token of ['{#each', 'onChange', 'GenUI.issueNewTurn', 'DIL.useState']) assert.ok(!snapshot.text.includes(token));
    const answer = textNode('answer', 'question', 'assistant', fixture.raw);
    answer.message!.metadata = { model_dil_v2: {} };
    const conversation: ChatGPTApiConversationWithId = {
        id: 'captured-quiz', title: 'Quiz', createdAtMs: 1000, updatedAtMs: 2000, current_node: 'answer', is_archived: false,
        mapping: new Map(Object.entries<ChatGPTConversationNode>({ root: { id: 'root', children: ['question'] }, question: textNode('question', 'root', 'user', 'Quiz me'), answer })),
    };
    const parsed = parseChatGPTConversation({ conversation, assetsByNode: new Map() });
    assert.equal(parsed.conversation.detail.quality.status, 'complete');
    assert.ok(JSON.stringify(parsed.conversation.detail.messages).includes('COMPOST-END'));
    assert.equal((answer.message!.content as { parts: string[] }).parts[0], fixture.raw, 'source is not mutated');
    answer.message!.end_turn = false;
    const unfinished = parseChatGPTConversation({ conversation, assetsByNode: new Map() }).conversation.detail.quality;
    assert.deepEqual(unfinished, { status: 'complete', sourceTurn: 'unfinished' });
    answer.message!.end_turn = true; answer.parent = 'missing';
    assert.equal(parseChatGPTConversation({ conversation, assetsByNode: new Map() }).conversation.detail.quality.status, 'partial');
});

test('DIL AsyncImage gallery becomes one ordered image resource instead of leaked control JSON', () => {
    const url = 'https://images.openai.com/static-rsc-4/' + 'a'.repeat(300) + '?purpose=fullsize';
    const answer = textNode('answer', 'question', 'assistant', '<AsyncImage query="flow network"/>');
    const metadata = { model_dil_v2: {
        fallbackMarkdown: 'Before\n\n\uE200image_group\uE202{"query":["flow network"]}\uE201\n\nAfter',
        appData: { opGenui: { componentResults: { image: { componentName: 'AsyncImage', status: 'resolved',
            safe_urls: [url], state: { images: [{ content_url: url }, { content_url: url }] } } } } },
    } };
    const conversation = { id: 'gallery', title: 'Gallery', create_time: 1, update_time: 2, current_node: 'answer', is_archived: false,
        mapping: { root: { id: 'root', children: ['question'] }, question: textNode('question', 'root', 'user', 'Show diagram'), answer: { ...answer, message: { ...answer.message!, metadata } } } };
    const parsed = parseChatGPTConversation({ conversation: decodeChatGPTDetail(conversation, conversation.id), assetsByNode: new Map() });
    const message = parsed.conversation.detail.messages.at(-1)!;
    assert.deepEqual(message.content.map(b => b.type), ['paragraph', 'image', 'paragraph']);
    assert.equal(parsed.conversation.detail.assets.length, 1);
    assert.equal(parsed.conversation.detail.assets[0].sourceUri, url);
    assert.ok(parsed.conversation.detail.assets[0].id.length < 64);
    assert.ok(!JSON.stringify(message.content).includes('image_group'));
    assert.ok(metadata.model_dil_v2.fallbackMarkdown.includes('image_group'), 'source stays unchanged');
    const imageResult = metadata.model_dil_v2.appData.opGenui.componentResults.image;
    imageResult.safe_urls = [];
    assert.equal(parseChatGPTConversation({ conversation: decodeChatGPTDetail(conversation, conversation.id), assetsByNode: new Map() }).conversation.detail.assets.length, 0,
        'unapproved source URLs are never promoted into image resources');
    imageResult.safe_urls = ['https://invalid.example/x']; imageResult.state.images = [{content_url:'https://invalid.example/x'}];
    assert.equal(parseChatGPTConversation({ conversation: decodeChatGPTDetail(conversation, conversation.id), assetsByNode: new Map() }).conversation.detail.assets.length, 0);
});


test('DIL galleries bind each query to its resolution ID despite reordered results', () => {
    const answer = textNode('answer', 'question', 'assistant', '<AsyncImage/>');
    const urlA = 'https://images.openai.com/static-rsc-4/winding';
    const urlB = 'https://images.openai.com/static-rsc-4/ray';
    const metadata = { model_dil_v2: {
        fallbackMarkdown: 'Before\n\uE200image_group\uE202{"query":["winding"]}\uE201\nMiddle\n\uE200image_group\uE202{"query":["ray"]}\uE201\nAfter',
        code: '__dil.jsx(AsyncImage,{"query":"winding","__resolutionId":__dilConstants["4"]});__dil.jsx(AsyncImage,{"query":"ray","__resolutionId":__dilConstants["8"]})',
        constants: Object.fromEntries([['4', 'id-a'], ['8', 'id-b']]),
        appData: { opGenui: { componentResults: {
            'id-b': { componentName: 'AsyncImage', status: 'resolved', safe_urls: [urlB], state: { images: [{ content_url: urlB }] } },
            'id-a': { componentName: 'AsyncImage', status: 'resolved', safe_urls: [urlA], state: { images: [{ content_url: urlA }] } },
        } } },
    } };
    const conversation = { id: 'galleries', title: 'Gallery', create_time: 1, update_time: 2, current_node: 'answer', is_archived: false,
        mapping: { root: { id: 'root', children: ['question'] }, question: textNode('question', 'root', 'user', 'Show diagrams'), answer: { ...answer, message: { ...answer.message!, metadata } } } };
    const parsed = parseChatGPTConversation({ conversation: decodeChatGPTDetail(conversation, conversation.id), assetsByNode: new Map() });
    assert.deepEqual(parsed.conversation.detail.assets.map(asset => asset.sourceUri), [urlA, urlB]);
    assert.deepEqual(parsed.conversation.detail.messages.at(-1)!.content.map(block => block.type), ['paragraph', 'image', 'paragraph', 'image', 'paragraph']);
    conversation.mapping.answer.message.metadata = { model_dil_v2: { ...metadata.model_dil_v2, constants: {} } };
    assert.equal(parseChatGPTConversation({ conversation: decodeChatGPTDetail(conversation, conversation.id), assetsByNode: new Map() }).conversation.detail.assets.length, 0, 'ambiguous multi-gallery ordering is never guessed');
});

test('DIL fallback norm escapes preserve all table cells and math', () => {
    const answer = textNode('answer', 'question', 'assistant', '<table/>');
    answer.message!.metadata = { model_dil_v2: { fallbackMarkdown: String.raw`| Check | Assertion | Purpose |
|---|---|---|
| Optimality | \(\\|x-\Pi(x)\\|_\infty<10^{-9}\) | Checks residual |` } };
    const conversation = { id: 'norm', title: 'Norm', createdAtMs: 1000, updatedAtMs: 2000, current_node: 'answer', is_archived: false,
        mapping: new Map(Object.entries<ChatGPTConversationNode>({ root: { id: 'root', children: ['question'] }, question: textNode('question', 'root', 'user', 'Verify'), answer })) };
    const blocks = parseChatGPTConversation({ conversation, assetsByNode: new Map() }).conversation.detail.messages.at(-1)!.content;
    const serialized = JSON.stringify(blocks);
    assert.ok(serialized.includes('Checks residual'));
    const table = blocks.find(block => block.type === 'table');
    assert.ok(table && table.type === 'table');
    assert.equal(table.rows[0].cells.length, 3);
    const math = table.rows[0].cells[1].children.find(node => node.type === 'inlineMath');
    assert.ok(math && math.type === 'inlineMath');
    assert.doesNotThrow(() => katex.renderToString(math.source, { throwOnError: true }));
    assert.ok(serialized.includes('Vert{}'));
    assert.ok(!serialized.includes('inlineCode'));
});

test('an unclosed inline opener cannot consume formulas in later table cells or rows', () => {
    const source = String.raw`| Bulk \(C_0\) \(wt% B) | \(f_\alpha\) \(exact) | \(f_\beta\) \(exact) |
| --- | --- | --- |
| 20 | \(1\) | \(0\) |`;
    const actual = preprocessChatGPTMarkdown(source);
    assert.ok(actual.includes(String.raw`| Bulk $C_0$ \(wt% B) | $f_\alpha$ \(exact) | $f_\beta$ \(exact) |`));
    assert.ok(actual.includes('| 20 | $1$ | $0$ |'));
});

test('ChatGPT 429 stops immediately and persists an account cooldown across provider instances', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const account = await getOrCreateAccount('chatgpt', JSON.stringify(['retry-user', 'retry-space']));
    let calls = 0, sessions = 0;
    const diagnostics: Diagnostic[] = [];
    const fetchFn = async (url: string) => {
        if (url.endsWith('/api/auth/session')) {
            sessions++;
            return Response.json(chatgptSessionGen('C_PROVIDER_CHATGPT_TREE_RETRY_429_SESSION_01'));
        }
        calls++;
        return calls === 1 ? new Response(null, { status: 429, headers: { 'Retry-After': '90' } })
            : Response.json(chatgptListGen('C_PROVIDER_CHATGPT_TREE_RETRY_429_LIST_01'));
    };
    const options = { accountId: account.id, streamId: 'recent', onDiagnostic: (d: Diagnostic) => diagnostics.push(d) } as const;
    await assert.rejects(new ChatGPTProvider({ fetchFn }).listConversations(options), { httpStatus: 429 });
    assert.equal(calls, 1);
    const limited = diagnostics[0]?.details;
    assert.ok(limited && typeof limited === 'object' && !Array.isArray(limited));
    assert.equal(limited.retryAfterMs, 90000);
    assert.equal(limited.delayMs, 3_600_000);
    assert.equal(limited.retryAt, 3_600_000);
    assert.equal(limited.willRetry, false);
    const next = new ChatGPTProvider({ fetchFn });
    t.mock.timers.tick(3_599_999);
    await assert.rejects(next.listConversations(options), { httpStatus: 429 });
    assert.equal(calls, 1);
    assert.equal(sessions, 1, 'cooldown blocks even session and token requests');
    assert.equal(diagnostics.at(-1)?.code, 'CHATGPT_COOLDOWN_ACTIVE');
    t.mock.timers.tick(1);
    assert.equal(calls, 1, 'cooldown expiry never starts an automatic retry');
    assert.equal(await next.listConversations(options), 'source_end');
    assert.equal(calls, 2);
    assert.doesNotMatch(JSON.stringify(diagnostics), /Bearer|accessToken|backend-api|retry-user/);
});

test('session 429 also stops before a backend request and establishes the account cooldown', async t => {
    const account = await getOrCreateAccount('chatgpt', 'default');
    const diagnostics: Diagnostic[] = [];
    let calls = 0;
    const provider = new ChatGPTProvider({ fetchFn: async url => {
        calls++;
        assert.ok(url.endsWith('/api/auth/session'));
        return new Response(null, { status: 429 });
    } });
    await assert.rejects(provider.listConversations({ accountId: account.id, streamId: 'recent',
        onDiagnostic: d => diagnostics.push(d) }), { httpStatus: 429 });
    await assert.rejects(provider.listConversations({ accountId: account.id, streamId: 'recent' }), { httpStatus: 429 });
    assert.equal(calls, 1);
    assert.equal(diagnostics[0]?.code, 'CHATGPT_RATE_LIMITED');
});

test('a cancelled ChatGPT read never starts another request', async t => {
    const account = await getOrCreateAccount('chatgpt', JSON.stringify(['abort-user', 'abort-space']));
    let calls = 0;
    const provider = new ChatGPTProvider({ fetchFn: async () => { calls++; throw new Error('Unexpected request'); } });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(provider.listConversations({ accountId: account.id, streamId: 'recent', signal: controller.signal }), { name: 'AbortError' });
    assert.equal(calls, 0);
});

test('live ChatGPT Markdown resources close over registered assets without touching code', () => {
    const pointer = 'sandbox:/mnt/data/generated/contact-sheet.png';
    const conversation: ChatGPTApiConversationWithId = {
        id: 'markdown-resources', title: 'Resources', is_archived: false, current_node: 'a',
        mapping: new Map([
            ['u', textNode('u', undefined, 'user', 'Show the report')],
            ['a', textNode('a', 'u', 'assistant',
                `![Preview](${pointer})\n\n[Download](sandbox:/mnt/data/report.csv)\n\n![Preview again](${pointer})\n\n\`\`\`md\n![code](sandbox:/mnt/data/not-an-asset.png)\n\`\`\``)],
        ]),
    };
    const result = parseChatGPTConversation({ conversation, assetsByNode: new Map() });
    const detail = result.conversation.detail;
    assert.doesNotThrow(() => assertDomainClosure(detail));
    assert.equal(detail.assets.length, 2);
    assert.equal(detail.assets.filter(asset => readChatGPTSandboxLocator(asset.sourceUri ?? '')?.path === '/mnt/data/generated/contact-sheet.png').length, 1);
    assert.ok(detail.assets.some(asset => readChatGPTSandboxLocator(asset.sourceUri ?? '')?.path === '/mnt/data/report.csv' && asset.kind === 'file'));
    assert.ok(detail.assets.every(asset => readChatGPTSandboxLocator(asset.sourceUri ?? '')?.messageId === 'msg-a'));
    const archive = parseOpenAIConversation(conversation);
    assert.ok(archive.conversation.detail.assets.some(asset => asset.sourceUri === pointer));
    assert.ok(detail.messages.some(message => message.content.some(block => block.type === 'code')));
});

test('sandbox files with the same path stay scoped to their provider message', () => {
    const conversation: ChatGPTApiConversationWithId = {
        id: 'sandbox-messages', title: 'Generated files', is_archived: false, current_node: 'second',
        mapping: new Map([
            ['root', { id: 'root', children: ['first'] }],
            ['first', textNode('first', 'root', 'assistant', '[File](sandbox:/mnt/data/report.csv)')],
            ['second', textNode('second', 'first', 'assistant', '[New file](sandbox:/mnt/data/report.csv)')],
        ]),
    };
    const { assets } = parseChatGPTConversation({ conversation, assetsByNode: new Map() }).conversation.detail;
    assert.equal(assets.length, 2);
    assert.notEqual(assets[0].id, assets[1].id);
    assert.deepEqual(assets.map(asset => readChatGPTSandboxLocator(asset.sourceUri ?? '')?.messageId), ['msg-first', 'msg-second']);
    assert.ok(assets.every(asset => asset.name === 'report.csv'));
});

for (const sourceUri of ['sediment://file_missing', 'file-download:file_missing', chatGPTSandboxLocator('message', '/mnt/data/missing.zip')]) {
    test(`fresh native locator 404 is distinct from a signed URL failure: ${sourceUri}`, async () => {
        const account = await getOrCreateAccount('chatgpt', 'default');
        const provider = new ChatGPTProvider({ fetchFn: async url => url.endsWith('/api/auth/session')
            ? new Response(JSON.stringify(chatgptSessionGen('C_FILE_DOWNLOAD_SESSION_01')))
            : new Response(null, { status: 404 }) });
        await assert.rejects(provider.acquireResource({ accountId: account.id, conversationId: 'missing' },
            { id: 'asset', kind: 'file', sourceUri }), { code: 'RESOURCE_LOCATOR_UNAVAILABLE', httpStatus: 404 });
    });
}

test('a successful native exchange followed by signed URL 404 remains refreshable', async () => {
    const account = await getOrCreateAccount('chatgpt', 'default');
    const provider = new ChatGPTProvider({ fetchFn: async url => {
        if (url.endsWith('/api/auth/session')) return new Response(JSON.stringify(chatgptSessionGen('C_FILE_DOWNLOAD_SESSION_01')));
        if (url.includes('/backend-api/')) return new Response(JSON.stringify(fileDownloadGen('C_ATTACHMENT_DOWNLOAD_ACQUIRE_01')));
        return new Response(null, { status: 404 });
    } });
    await assert.rejects(provider.acquireResource({ accountId: account.id, conversationId: 'missing' },
        { id: 'asset', kind: 'file', sourceUri: 'file-download:file_missing' }),
    error => error instanceof ResourceHttpError && error.httpStatus === 404);
});


test('a session endpoint 404 is not classified as a missing attachment locator', async () => {
    const account = await getOrCreateAccount('chatgpt', 'default');
    const provider = new ChatGPTProvider({ fetchFn: async () => new Response(null, { status: 404 }) });
    await assert.rejects(provider.acquireResource({ accountId: account.id, conversationId: 'missing' },
        { id: 'asset', kind: 'file', sourceUri: 'file-download:file_missing' }),
    { code: 'SOURCE_HTTP_ERROR', httpStatus: 404 });
});


test('concurrent and subsequent ChatGPT attachments share one session request', async () => {
    const account = await getOrCreateAccount('chatgpt', 'default');
    let sessions = 0, exchanges = 0;
    const provider = new ChatGPTProvider({ fetchFn: async url => {
        if (url.endsWith('/api/auth/session')) {
            sessions++;
            await new Promise(resolve => setImmediate(resolve));
            return Response.json(chatgptSessionGen('C_FILE_DOWNLOAD_SESSION_01'));
        }
        if (url.includes('/backend-api/')) {
            exchanges++;
            return Response.json(fileDownloadGen('C_FILE_DOWNLOAD_ACQUIRE_01'));
        }
        return new Response(signedAssetGen('C_SIGNED_ASSET_CAT_PNG_01'));
    } });
    const acquire = () => provider.acquireResource({ accountId: account.id, conversationId: 'token-reuse' },
        { id: 'asset', kind: 'file', sourceUri: 'sediment://file_cat' });
    await Promise.all([acquire(), acquire(), acquire()]);
    await acquire();
    assert.equal(sessions, 1);
    assert.equal(exchanges, 4);
});

for (const status of [401, 403]) {
    test(`ChatGPT authentication recovery is bounded for HTTP ${status}`, async () => {
        const account = await getOrCreateAccount('chatgpt', 'default');
        let sessions = 0, calls = 0;
        const provider = new ChatGPTProvider({ fetchFn: async url => {
            if (url.endsWith('/api/auth/session')) {
                sessions++;
                return Response.json(chatgptSessionGen('C_FILE_DOWNLOAD_SESSION_01'));
            }
            calls++;
            return new Response(null, { status });
        } });
        await assert.rejects(provider.fetchConversationDetail(account.id, 'auth-failed'), { httpStatus: status });
        assert.equal(calls, status === 401 ? 2 : 1);
        assert.equal(sessions, status === 401 ? 2 : 1);
    });
}

test('ChatGPT retries with refreshed credentials after one 401', async () => {
    const account = await getOrCreateAccount('chatgpt', 'default');
    let sessions = 0, calls = 0;
    const provider = new ChatGPTProvider({ fetchFn: async (url, init) => {
        if (url.endsWith('/api/auth/session')) {
            sessions++;
            return Response.json(chatgptSessionGen(sessions === 1
                ? 'C_TOKEN_REUSE_INITIAL' : 'C_TOKEN_REUSE_REFRESHED'));
        }
        calls++;
        assert.equal(new Headers(init?.headers).get('Authorization'), calls === 1 ? 'Bearer old-token' : 'Bearer refreshed-token');
        if (calls === 1) return new Response(null, { status: 401 });
        return Response.json(chatgptDetailGen('C_PROVIDER_CHATGPT_TREE_IMAGE_DETAIL_01'));
    } });
    await provider.fetchConversationDetail(account.id, 'conv-img');
    assert.equal(sessions, 2);
    assert.equal(calls, 2);
});


test('late concurrent ChatGPT 401 responses share the refreshed session', async () => {
    const account = await getOrCreateAccount('chatgpt', 'default');
    let sessions = 0, staleCalls = 0, freshCalls = 0;
    let releaseLate: (() => void) | undefined;
    const late = new Promise<void>(resolve => { releaseLate = resolve; });
    const provider = new ChatGPTProvider({ fetchFn: async (url, init) => {
        if (url.endsWith('/api/auth/session')) {
            sessions++;
            return Response.json(chatgptSessionGen(sessions === 1
                ? 'C_TOKEN_REUSE_INITIAL' : 'C_TOKEN_REUSE_REFRESHED'));
        }
        if (new Headers(init?.headers).get('Authorization') === 'Bearer old-token') {
            staleCalls++;
            if (staleCalls === 2) await late;
            return new Response(null, { status: 401 });
        }
        freshCalls++;
        releaseLate?.();
        return new Response(null, { status: 404 });
    } });
    const acquire = () => provider.acquireResource({ accountId: account.id, conversationId: 'concurrent-auth' },
        { id: 'asset', kind: 'file', sourceUri: 'sediment://file_cat' });
    const results = await Promise.allSettled([acquire(), acquire()]);
    assert.ok(results.every(result => result.status === 'rejected'));
    assert.equal(staleCalls, 2);
    assert.equal(freshCalls, 2);
    assert.equal(sessions, 2);
});

test('ChatGPT session failures can be retried and tokens are isolated by account', async () => {
    const first = await getOrCreateAccount('chatgpt', JSON.stringify(['bounded-user', 'space']));
    const second = await getOrCreateAccount('chatgpt', JSON.stringify(['another-user', 'space']));
    let sessions = 0, calls = 0;
    const provider = new ChatGPTProvider({ fetchFn: async url => {
        if (url.endsWith('/api/auth/session')) {
            sessions++;
            if (sessions === 1) return new Response(null, { status: 503 });
            return Response.json(chatgptSessionGen(sessions === 2
                ? 'C_PROVIDER_CHATGPT_TREE_BOUNDED_429_SESSION_01'
                : 'C_PROVIDER_CHATGPT_TREE_BOUNDED_429_SESSION_02'));
        }
        calls++;
        return new Response(null, { status: 404 });
    } });
    await assert.rejects(provider.fetchConversationDetail(first.id, 'auth-isolation'), { httpStatus: 503 });
    await assert.rejects(provider.fetchConversationDetail(first.id, 'auth-isolation'), { httpStatus: 404 });
    await assert.rejects(provider.fetchConversationDetail(second.id, 'auth-isolation'), { httpStatus: 404 });
    await assert.rejects(provider.fetchConversationDetail(first.id, 'auth-isolation'), { httpStatus: 404 });
    assert.equal(sessions, 3);
    assert.equal(calls, 3);
});


for (const scenario of [
    { name: 'short server delay', header: '6', delay: 6000 },
    { name: 'long server delay', header: '7200', delay: 7200000 },
    { name: 'HTTP date', header: 'Thu, 01 Jan 1970 00:00:06 GMT', delay: 6000 },
    { name: 'zero server delay', header: '0', delay: 0 },
    { name: 'past HTTP date', header: 'Wed, 31 Dec 1969 23:59:59 GMT', delay: 0 },
    { name: 'missing header', header: undefined, delay: undefined },
    { name: 'invalid header', header: 'not-a-date', delay: undefined },
    { name: 'negative delay', header: '-1', delay: undefined },
]) {
    test(`ChatGPT 429 stops with an hour floor: ${scenario.name}`, async t => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
        const account = await getOrCreateAccount('chatgpt', JSON.stringify(['retry-user', 'retry-space']));
        const diagnostics: Diagnostic[] = [];
        let calls = 0;
        const provider = new ChatGPTProvider({ fetchFn: async url => {
            if (url.endsWith('/api/auth/session'))
                return Response.json(chatgptSessionGen('C_PROVIDER_CHATGPT_TREE_RETRY_429_SESSION_01'));
            calls++;
            return new Response(null, { status: 429,
                headers: scenario.header === undefined ? {} : { 'Retry-After': scenario.header } });
        } });
        await assert.rejects(provider.listConversations({ accountId: account.id, streamId: 'recent',
            onDiagnostic: d => diagnostics.push(d) }), { httpStatus: 429 });
        assert.equal(calls, 1);
        const details = diagnostics[0]?.details;
        assert.ok(details && typeof details === 'object' && !Array.isArray(details));
        assert.equal(details.retryAt, Math.max(3_600_000, scenario.delay ?? 0));
        assert.equal(details.willRetry, false);
    });
}

test('attachment locator 429 stops and blocks later reads for the same account', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const account = await getOrCreateAccount('chatgpt', JSON.stringify(['retry-user', 'retry-space']));
    const diagnostics: Diagnostic[] = [];
    let calls = 0;
    const provider = new ChatGPTProvider({ fetchFn: async url => {
        if (url.endsWith('/api/auth/session')) return Response.json(chatgptSessionGen('C_PROVIDER_CHATGPT_TREE_RETRY_429_SESSION_01'));
        calls++;
        return new Response(null, { status: 429, headers: { 'Retry-After': '60' } });
    } });
    await assert.rejects(provider.acquireResource({ accountId: account.id, conversationId: 'shared-wait' },
        { id: 'asset', kind: 'file', sourceUri: 'sediment://file_cat' }, undefined, d => diagnostics.push(d)), { httpStatus: 429 });
    await assert.rejects(provider.listConversations({ accountId: account.id, streamId: 'recent', onDiagnostic: d => diagnostics.push(d) }), { httpStatus: 429 });
    await assert.rejects(provider.acquireResource({ accountId: account.id, conversationId: 'shared-wait' },
        { id: 'image', kind: 'image', sourceUri: 'https://example.test/image.png' }), { httpStatus: 429 });
    assert.equal(calls, 1);
    assert.equal(diagnostics[0]?.code, 'CHATGPT_RATE_LIMITED');
    assert.equal(diagnostics.at(-1)?.code, 'CHATGPT_COOLDOWN_ACTIVE');
});
