export {};
const test = require('node:test');
const assert = require('node:assert');

// 1. D3: Detail Pagination Truncation Reporting
test('D3: getConversationDetail flags truncated=true when exceeding the 2000-page safety limit', async () => {
    const Pagination = require('../src/core/api/client/pagination.js');

    let pageCalls = 0;
    const mockClient = {
        fetchConversationPage: async (_cid: string, token: string | null) => {
            pageCalls++;
            return {
                id: 'chat_long',
                title: 'Long Chat',
                messages: [{ id: `msg_${pageCalls}`, timestamp: 1700000000000 + pageCalls * 1000 }],
                nextPageToken: `token_page_${pageCalls + 1}`
            };
        }
    };

    const detail = await Pagination.getConversationDetail(mockClient, 'chat_long');
    assert.strictEqual(pageCalls, 2000, 'Should stop at the 2000-page safety limit');
    assert.strictEqual(detail.truncated, true, 'detail must be flagged as truncated');
    assert.strictEqual(detail.isTruncated, true);
    assert.strictEqual(detail.truncateReason, 'safety_limit');
});

test('D3: getConversationDetail flags truncated=true on detail cursor token loop', async () => {
    const Pagination = require('../src/core/api/client/pagination.js');

    let pageCalls = 0;
    const mockClient = {
        fetchConversationPage: async () => {
            pageCalls++;
            return {
                id: 'chat_loop',
                title: 'Looping Detail Chat',
                messages: [{ id: `msg_${pageCalls}`, timestamp: 1700000000000 + pageCalls * 1000 }],
                nextPageToken: 'repeating_detail_token'
            };
        }
    };

    const detail = await Pagination.getConversationDetail(mockClient, 'chat_loop');
    assert.strictEqual(pageCalls, 2, 'Should break on repeated token (callCount = 2)');
    assert.strictEqual(detail.truncated, true, 'detail must be flagged as truncated on loop');
    assert.strictEqual(detail.truncateReason, 'token_loop');
});

// 2. D5: Failed items show failure badge, never ok badge
test('D5: resolveConversationExportState returns badgeKind=failed for failed records and session failures', () => {
    const { resolveConversationExportState } = require('../src/core/utils/titleUtils.js');
    const chat = { id: 'c_failed_1', title: 'Failed Chat', timestamp: 1700000000000 };

    // Case A: Persisted record with status: 'failed'
    const stRecord = resolveConversationExportState(chat, {
        exportedAt: new Date().toISOString(),
        status: 'failed',
        messageCount: 5
    });
    assert.strictEqual(stRecord.state, 'failed');
    assert.strictEqual(stRecord.badge.kind, 'failed');
    assert.notStrictEqual(stRecord.badge.kind, 'exported_ok', 'Failed record must NEVER have exported_ok badge');
    assert.strictEqual(stRecord.badge.className, 'badge badge-failed');

    // Case B: Session failure without persisted record
    const stSession = resolveConversationExportState(chat, null, { isFailedInSession: true });
    assert.strictEqual(stSession.state, 'failed');
    assert.strictEqual(stSession.badge.kind, 'failed');
    assert.strictEqual(stSession.badge.className, 'badge badge-failed');
});

// 3. D6: Live Save image naming collision avoidance
test('D6: liveSaveCoordinator deduplicates candidateName collisions within the same turn', async () => {
    const LiveSaveCoordinator = require('../src/content/liveSaveCoordinator.js');

    const writtenFiles = new Map<string, any>();
    const mockWriter = {
        writeFile: async (subDir: string, fileName: string, buffer: any) => {
            writtenFiles.set(`${subDir}/${fileName}`, buffer);
        }
    };

    const chatWithCollidingImages = {
        id: 'c_col_12345678',
        title: 'Collision Chat',
        messages: [
            {
                role: 'model',
                attachments: [
                    {
                        type: 'image',
                        url: 'https://example.com/images/first_diagram.png',
                        fileName: 'diagram.png'
                    },
                    {
                        type: 'image',
                        url: 'https://example.com/images/second_diagram.png',
                        fileName: 'diagram.png'
                    }
                ]
            }
        ]
    };

    const mockFetcher = {
        fetchImageBuffer: async (url: string) => {
            if (url.includes('first')) return { buffer: Buffer.from('BYTES_IMAGE_1'), ext: 'png' };
            return { buffer: Buffer.from('BYTES_IMAGE_2'), ext: 'png' };
        }
    };

    LiveSaveCoordinator.init({
        assetFetcher: mockFetcher
    });

    const saved = await LiveSaveCoordinator.processAndSaveImages(
        chatWithCollidingImages,
        chatWithCollidingImages.id,
        mockWriter
    );

    assert.strictEqual(saved.length, 2, 'Both images must be saved');
    assert.notStrictEqual(saved[0].fileName, saved[1].fileName, 'Both images must have distinct file names');
    assert.strictEqual(writtenFiles.size, 2, 'Two separate files must exist on disk without overwriting');

    // Verify chat messages have distinct relative URLs
    const att1: any = chatWithCollidingImages.messages[0].attachments[0];
    const att2: any = chatWithCollidingImages.messages[0].attachments[1];
    assert.notStrictEqual(att1.localName, att2.localName, 'Attachments must point to distinct local paths');
});
