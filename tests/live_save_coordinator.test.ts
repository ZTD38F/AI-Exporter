export {};
const test = require('node:test');
const assert = require('node:assert');
const LiveSaveCoordinator = require('../src/content/liveSaveCoordinator.js');

test('liveSaveCoordinator - executeLiveSave with direct Disk persistence', async () => {
    let writtenFiles: Record<string, string> = {};
    let feedbackCalledWith: string | null = null;

    const mockStorage = {
        getLiveConfig: async () => ({
            enabledDisk: true,
            format: 'markdown',
            includeAssets: true,
            dirName: 'ObsidianVault'
        }),
        getLiveDirHandle: async () => ({
            name: 'ObsidianVault'
        }),
        setLiveConfig: async () => {}
    };

    const mockScraper = {
        parseDoc: (doc: any, id: string) => ({
            id,
            title: 'Quantum Computing Intro',
            messages: [
                { role: 'user', content: 'What is superposition?' },
                { role: 'model', content: 'Superposition is a fundamental principle of quantum mechanics.' }
            ],
            timestamp: 1710000000000
        })
    };

    let writerFolderUsed = '';
    class MockFsWriter {
        dirHandle: any;
        folderName: string;
        constructor(handle: any, folder: string) {
            this.dirHandle = handle;
            this.folderName = folder;
            writerFolderUsed = folder;
        }
        async init() {}
        async writeFile(subDir: string, name: string, content: string) {
            const path = subDir ? `${subDir}/${name}` : name;
            writtenFiles[path] = content;
            return name;
        }
    }

    const mockBadge = {
        showLiveSaveFeedback: (title: string) => {
            feedbackCalledWith = title;
        }
    };

    LiveSaveCoordinator.init({
        storageManager: mockStorage,
        scraper: mockScraper,
        fsWriterClass: MockFsWriter,
        badge: mockBadge,
        clientClass: null // Force fallback to scraper
    });

    const success = await LiveSaveCoordinator.executeLiveSave('c_9876543210abcdef', 'turn_complete');
    assert.strictEqual(success, true);

    // 1. Verify Disk FsWriter persistence with gemini_export folder and _cid6.md
    assert.strictEqual(writerFolderUsed, 'gemini_export');
    const expectedFile = 'Quantum Computing Intro_abcdef.md';
    assert.ok(expectedFile in writtenFiles);
    assert.ok(writtenFiles[expectedFile].includes('What is superposition?'));
    assert.ok(writtenFiles[expectedFile].includes('Superposition is a fundamental principle'));

    // 2. Verify no index README.md is written (pure conversation export)
    assert.strictEqual('README.md' in writtenFiles, false);

    // 4. Verify Badge feedback called
    assert.strictEqual(feedbackCalledWith, 'Quantum Computing Intro');
});

test('liveSaveCoordinator - executeLiveSave delegates via chrome.runtime.sendMessage when local handle is null', async () => {
    let sentMessage: any = null;
    let feedbackCalled = false;

    const mockStorage = {
        getLiveConfig: async () => ({
            enabledDisk: true,
            format: 'markdown',
            includeAssets: true,
            dirName: 'MyVault'
        }),
        getLiveDirHandle: async () => null, // No local handle
        setLiveConfig: async () => {}
    };

    const mockScraper = {
        parseDoc: (_doc: any, id: string) => ({
            id,
            title: 'Delegated Live Save Test',
            messages: [{ role: 'user', content: 'hello' }, { role: 'model', content: 'world' }],
            timestamp: Date.now()
        })
    };

    const origChrome = (global as any).chrome;
    (global as any).chrome = {
        runtime: {
            sendMessage: (msg: any, cb: (res: any) => void) => {
                sentMessage = msg;
                if (cb) cb({ ok: true, handleName: 'MyVault' });
            }
        }
    };

    try {
        LiveSaveCoordinator.init({
            storageManager: mockStorage,
            scraper: mockScraper,
            badge: {
                showLiveSaveFeedback: () => { feedbackCalled = true; }
            },
            clientClass: null
        });

        const success = await LiveSaveCoordinator.executeLiveSave('c_delegated123', 'turn_complete');
        assert.strictEqual(success, true);
        assert.ok(sentMessage);
        const sent = sentMessage as any;
        assert.strictEqual(sent.action, 'liveSaveViaHandle');
        assert.strictEqual(sent.payload.safeTitle, 'Delegated Live Save Test');
        assert.strictEqual(feedbackCalled, true);
    } finally {
        (global as any).chrome = origChrome;
    }
});

test('liveSaveCoordinator - executeLiveSave cleanly aborts and returns false without downloading when handle is unavailable', async () => {
    let feedbackCalled = false;

    const mockStorage = {
        getLiveConfig: async () => ({
            enabledDisk: true,
            format: 'markdown',
            includeAssets: true,
            dirName: ''
        }),
        getLiveDirHandle: async () => null,
        setLiveConfig: async () => {}
    };

    const mockScraper = {
        parseDoc: (_doc: any, id: string) => ({
            id,
            title: 'No Handle Test',
            messages: [{ role: 'user', content: 'ping' }, { role: 'model', content: 'pong' }],
            timestamp: Date.now()
        })
    };

    const origChrome = (global as any).chrome;
    (global as any).chrome = {
        runtime: {
            sendMessage: (_msg: any, cb: (res: any) => void) => {
                if (cb) cb({ ok: false, error: 'no_dir_handle' });
            }
        }
    };

    try {
        LiveSaveCoordinator.init({
            storageManager: mockStorage,
            scraper: mockScraper,
            badge: {
                showLiveSaveFeedback: () => { feedbackCalled = true; },
                showLiveSaveWarning: () => {}
            },
            clientClass: null
        });

        const success = await LiveSaveCoordinator.executeLiveSave('c_nohandle456', 'turn_complete');
        // Live save must cleanly return false without downloading or polluting
        assert.strictEqual(success, false);
        assert.strictEqual(feedbackCalled, false);
    } finally {
        (global as any).chrome = origChrome;
    }
});

test('liveSaveCoordinator - executeLiveSave aborts and warns when configured dir is missing or deleted', async () => {
    let bgDownloadCalled = false;
    let warningCalledWith: string | null = null;

    const mockStorage = {
        getLiveConfig: async () => ({
            enabledDisk: true,
            format: 'markdown',
            includeAssets: true,
            dirName: 'MySpecialFolder'
        }),
        getLiveDirHandle: async () => null,
        setLiveConfig: async () => {}
    };

    const mockScraper = {
        parseDoc: (_doc: any, id: string) => ({
            id,
            title: 'Missing Dir Test',
            messages: [{ role: 'user', content: 'hello' }],
            timestamp: Date.now()
        })
    };

    const origChrome = (global as any).chrome;
    (global as any).chrome = {
        runtime: {
            sendMessage: (msg: any, cb: (res: any) => void) => {
                if (msg.action === 'liveSaveViaHandle') {
                    // Simulate directory deleted on disk
                    if (cb) cb({ ok: false, error: 'dir_not_found' });
                } else if (msg.action === 'liveSaveDownload') {
                    bgDownloadCalled = true;
                    if (cb) cb({ ok: true });
                }
            }
        }
    };

    try {
        LiveSaveCoordinator.init({
            storageManager: mockStorage,
            scraper: mockScraper,
            badge: {
                showLiveSaveWarning: (msg: string) => { warningCalledWith = msg; }
            },
            clientClass: null
        });

        const success = await LiveSaveCoordinator.executeLiveSave('c_missing_dir_123', 'turn_complete');
        // Live save must abort without downloading to ~/Downloads
        assert.strictEqual(success, false);
        assert.strictEqual(bgDownloadCalled, false, 'Must not pollute downloads when configured dir is missing');
        assert.ok(warningCalledWith !== null, 'Must warn user on badge');
        assert.ok(warningCalledWith!.includes('目录已删除') || warningCalledWith!.includes('Folder deleted'));
    } finally {
        (global as any).chrome = origChrome;
    }
});

test('liveSaveCoordinator - executeLiveSave catches native NotFoundError and resets config and warns', async () => {
    let resetConfig: any = null;
    let clearedHandle: any = 'not_called';
    let warningCalledWith: string | null = null;

    const mockStorage = {
        getLiveConfig: async () => ({
            enabledDisk: true,
            format: 'markdown',
            includeAssets: true,
            dirName: 'DeletedFolder'
        }),
        getLiveDirHandle: async () => ({ name: 'DeletedFolder' }),
        saveLiveDirHandle: async (h: any) => { clearedHandle = h; },
        setLiveConfig: async (cfg: any) => { resetConfig = cfg; }
    };

    const mockScraper = {
        parseDoc: (_doc: any, id: string) => ({
            id,
            title: 'Native Delete Test',
            messages: [{ role: 'user', content: 'test' }],
            timestamp: Date.now()
        })
    };

    class DeadFsWriter {
        constructor() {}
        async init() {}
        async writeFile() {
            const err = new Error('A requested file or directory could not be found at the time an operation was processed.');
            err.name = 'NotFoundError';
            throw err;
        }
    }

    LiveSaveCoordinator.init({
        storageManager: mockStorage,
        scraper: mockScraper,
        fsWriterClass: DeadFsWriter,
        badge: {
            showLiveSaveWarning: (msg: string) => { warningCalledWith = msg; }
        },
        clientClass: null
    });

    const success = await LiveSaveCoordinator.executeLiveSave('c_dead_native_456', 'turn_complete');
    assert.strictEqual(success, false);
    assert.strictEqual(clearedHandle, null, 'Must clear dead handle from IDB');
    assert.strictEqual(resetConfig?.enabledDisk, false);
    assert.strictEqual(resetConfig?.dirError, 'not_found');
    assert.ok(warningCalledWith !== null);
    assert.ok(warningCalledWith!.includes('目标目录已删除') || warningCalledWith!.includes('Folder deleted'));
});

test('liveSaveCoordinator - processAndSaveImages saves to assets/ with cid6 and rewrites markdown', async () => {
    let savedAssets: Array<{ subDir: string; fileName: string; buffer: any }> = [];
    const mockWriter = {
        writeFile: async (subDir: string, fileName: string, buffer: any) => {
            savedAssets.push({ subDir, fileName, buffer });
            return fileName;
        }
    };

    const mockFetcher = {
        fetchImageBuffer: async (url: string) => {
            return {
                buffer: Buffer.from('fake-image-bytes'),
                ext: 'png'
            };
        }
    };

    LiveSaveCoordinator.init({
        assetFetcher: mockFetcher
    });

    const chat = {
        messages: [
            {
                role: 'user',
                content: 'Generate an astronaut cat'
            },
            {
                role: 'model',
                content: 'Here is your cat: ![Astronaut Cat](https://example.com/images/cat.png)',
                attachments: [
                    { type: 'image', src: 'https://example.com/images/cat.png', name: 'cat.png' }
                ]
            }
        ]
    };

    const cid = 'c_0123456789abcdef';
    const collected = await LiveSaveCoordinator.processAndSaveImages(chat, cid, mockWriter);

    assert.strictEqual(savedAssets.length, 1);
    assert.strictEqual(savedAssets[0].subDir, 'assets');
    // cid6 is abcdef
    assert.ok(savedAssets[0].fileName.startsWith('abcdef_'));
    assert.ok(savedAssets[0].fileName.endsWith('.png'));

    // Verify markdown rewritten to assets/...
    assert.ok(chat.messages[1].content.includes('assets/abcdef_'));
    assert.strictEqual(chat.messages[1].content.includes('attachments/'), false);
    assert.strictEqual((chat.messages[1] as any)?.attachments?.[0]?.localName, `assets/${savedAssets[0].fileName}`);

    // Verify collected assets returned with valid base64 payload
    assert.strictEqual(collected.length, 1);
    assert.strictEqual(collected[0].subDir, 'assets');
    assert.strictEqual(collected[0].fileName, savedAssets[0].fileName);
    assert.strictEqual(collected[0].base64, Buffer.from('fake-image-bytes').toString('base64'));
});

test('liveSaveCoordinator - arrayBufferToBase64 converts binary buffers correctly without overflow', () => {
    const rawStr = 'hello-gemini-live-save-binary-asset-test';
    const buf = Buffer.from(rawStr);
    const b64 = LiveSaveCoordinator.arrayBufferToBase64(buf);
    assert.strictEqual(b64, buf.toString('base64'));

    const emptyB64 = LiveSaveCoordinator.arrayBufferToBase64(null);
    assert.strictEqual(emptyB64, '');
});


