export {};
const test = require('node:test');
const assert = require('node:assert');
const LiveSaveCoordinator = require('../src/content/liveSaveCoordinator.js');
const AssetFetcher = require('../src/content/assetFetcher.js');

test('liveSaveCoordinator - multimodal image pipeline (user uploads & Imagen generated)', async () => {
    let writtenFiles: Record<string, any> = {};
    let fetchedUrls: string[] = [];

    const mockStorage = {
        getLiveConfig: async () => ({
            enabledDisk: true,
            format: 'markdown',
            includeAssets: true,
            updateIndex: true,
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
            title: 'Multimodal Cat & Cyberpunk Art',
            messages: [
                {
                    role: 'user',
                    content: 'Can you enhance this cat photo into a cyberpunk style?',
                    attachments: [
                        {
                            type: 'image',
                            name: 'cute_cat.jpg',
                            alt: 'Cute Cat Photo',
                            src: 'https://lh3.googleusercontent.com/user_cat_photo_123',
                            isImage: true
                        }
                    ]
                },
                {
                    role: 'model',
                    content: 'Here is your cyberpunk cat!\n\n![Generated Cyberpunk Cat](https://lh3.googleusercontent.com/imagen_cat_artwork_456)',
                    images: [
                        {
                            url: 'https://lh3.googleusercontent.com/imagen_cat_artwork_456',
                            fileName: 'cyberpunk_cat.png',
                            name: 'cyberpunk_cat.png',
                            alt: 'Generated Cyberpunk Cat',
                            isGenerated: true,
                            isImage: true
                        }
                    ],
                    attachments: [
                        {
                            type: 'image',
                            name: 'cyberpunk_cat.png',
                            fileName: 'cyberpunk_cat.png',
                            alt: 'Generated Cyberpunk Cat',
                            src: 'https://lh3.googleusercontent.com/imagen_cat_artwork_456',
                            isImage: true
                        }
                    ]
                }
            ],
            timestamp: 1710000000000
        })
    };

    class MockFsWriter {
        dirHandle: any;
        folderName: string;
        constructor(handle: any, folder: string) {
            this.dirHandle = handle;
            this.folderName = folder;
        }
        async init() {}
        async writeFile(subDir: string, name: string, content: any) {
            const path = subDir ? `${subDir}/${name}` : name;
            writtenFiles[path] = content;
            return name;
        }
    }

    const mockAssetFetcher = {
        fetchImageBuffer: async (url: string) => {
            fetchedUrls.push(url);
            if (url.includes('user_cat_photo_123')) {
                const buf = new Uint8Array([1, 2, 3, 4, 5]).buffer;
                return { buffer: buf, mimeType: 'image/jpeg', ext: 'jpg' };
            }
            if (url.includes('imagen_cat_artwork_456')) {
                const buf = new Uint8Array([6, 7, 8, 9, 10, 11]).buffer;
                return { buffer: buf, mimeType: 'image/png', ext: 'png' };
            }
            return null;
        }
    };

    LiveSaveCoordinator.init({
        storageManager: mockStorage,
        scraper: mockScraper,
        fsWriterClass: MockFsWriter,
        assetFetcher: mockAssetFetcher,
        clientClass: null
    });

    const success = await LiveSaveCoordinator.executeLiveSave('c_1122334455667788', 'turn_complete');
    assert.strictEqual(success, true);

    // 1. Verify all images were fetched
    assert.strictEqual(fetchedUrls.length, 2);
    assert.ok(fetchedUrls.includes('https://lh3.googleusercontent.com/user_cat_photo_123'));
    assert.ok(fetchedUrls.includes('https://lh3.googleusercontent.com/imagen_cat_artwork_456'));

    // 3. Verify images were saved into assets/
    const assetFiles = Object.keys(writtenFiles).filter(k => k.startsWith('assets/'));
    assert.strictEqual(assetFiles.length, 2);

    const userCatFile = assetFiles.find(f => f.includes('cute_cat.jpg') || f.includes('t1_'));
    assert.ok(userCatFile, 'User cat photo should be saved in assets/');
    assert.strictEqual((writtenFiles[userCatFile!] as ArrayBuffer).byteLength, 5);

    const imagenFile = assetFiles.find(f => f.includes('cyberpunk_cat.png') || f.includes('t2_'));
    assert.ok(imagenFile, 'Imagen generated artwork should be saved in assets/');
    assert.strictEqual((writtenFiles[imagenFile!] as ArrayBuffer).byteLength, 6);

    // 4. Verify Markdown file content has relative assets/ paths
    const mdFile = 'Multimodal Cat & Cyberpunk Art_667788.md';
    assert.ok(mdFile in writtenFiles, 'Markdown file should be written');
    const mdContent = writtenFiles[mdFile];

    assert.ok(mdContent.includes(userCatFile), `Markdown should link to user image at ${userCatFile}`);
    assert.ok(mdContent.includes(imagenFile), `Markdown should link to model image at ${imagenFile}`);
    assert.ok(!mdContent.includes('https://lh3.googleusercontent.com/imagen_cat_artwork_456'), 'Online Imagen URL should be rewritten to relative assets path');
});

test('liveSaveCoordinator - image download error tolerance & graceful fallback', async () => {
    let writtenFiles: Record<string, any> = {};

    const mockStorage = {
        getLiveConfig: async () => ({
            enabledDisk: true,
            format: 'markdown',
            includeAssets: true,
            updateIndex: false,
            dirName: 'Vault'
        }),
        getLiveDirHandle: async () => ({ name: 'Vault' }),
        setLiveConfig: async () => {}
    };

    const mockScraper = {
        parseDoc: (doc: any, id: string) => ({
            id,
            title: 'Failing Image Test',
            messages: [
                {
                    role: 'user',
                    content: 'Image with network failure: ![Broken](https://example.com/broken_image.jpg)'
                }
            ],
            timestamp: 1710000000000
        })
    };

    class MockFsWriter {
        dirHandle: any;
        folderName: string;
        constructor(handle: any, folder: string) {
            this.dirHandle = handle;
            this.folderName = folder;
        }
        async init() {}
        async writeFile(subDir: string, name: string, content: any) {
            const path = subDir ? `${subDir}/${name}` : name;
            writtenFiles[path] = content;
            return name;
        }
    }

    const mockAssetFetcher = {
        fetchImageBuffer: async () => {
            // Simulate network timeout / 404
            return null;
        }
    };

    LiveSaveCoordinator.init({
        storageManager: mockStorage,
        scraper: mockScraper,
        fsWriterClass: MockFsWriter,
        assetFetcher: mockAssetFetcher,
        clientClass: null
    });

    const success = await LiveSaveCoordinator.executeLiveSave('c_aabbccddeeff0011', 'turn_complete');
    assert.strictEqual(success, true, 'Save should succeed even when image download fails');

    // Verify Markdown file was written with original remote URL intact
    const mdFile = 'Failing Image Test_ff0011.md';
    assert.ok(mdFile in writtenFiles);
    assert.ok(writtenFiles[mdFile].includes('https://example.com/broken_image.jpg'));
    // assets/ should have 0 files
    const assetFiles = Object.keys(writtenFiles).filter(k => k.startsWith('assets/'));
    assert.strictEqual(assetFiles.length, 0);
});

test('assetFetcher - inferImageExt correctly detects MIME and URL extensions', () => {
    assert.strictEqual(AssetFetcher.inferImageExt('image/png'), 'png');
    assert.strictEqual(AssetFetcher.inferImageExt('image/webp'), 'webp');
    assert.strictEqual(AssetFetcher.inferImageExt('image/gif'), 'gif');
    assert.strictEqual(AssetFetcher.inferImageExt('image/jpeg'), 'jpg');
    assert.strictEqual(AssetFetcher.inferImageExt(undefined, 'https://example.com/pic.png?alr=yes'), 'png');
    assert.strictEqual(AssetFetcher.inferImageExt(undefined, 'https://example.com/unknown'), 'jpg');
});
