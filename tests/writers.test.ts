export {};
const test = require('node:test');
const assert = require('node:assert');

const { FsWriter, ensureSubDir } = require('../src/l4/delivery/writers/fsWriter.js');
const { sanitizeFileName } = require('../src/shared/utils/pathUtils.js');
const { ZipWriter, isPrecompressedAsset } = require('../src/l4/packaging/writers/zipWriter.js');
const { __setZipConstructor } = require('../src/l4/packaging/writers/zipWriter.js');

// FsWriter
test('fsWriter - sanitizeFileName and ensureSubDir nested resolution', async () => {
    assert.strictEqual(sanitizeFileName('valid_name.md'), 'valid_name.md');
    assert.strictEqual(sanitizeFileName(''), 'untitled');
    assert.strictEqual(sanitizeFileName(null), 'untitled');
    assert.strictEqual(sanitizeFileName('invalid:name*with?chars.txt'), 'invalid_name_with_chars.txt');

    const createdDirs: string[] = [];
    const mockRootHandle = {
        name: 'root',
        async getDirectoryHandle(name: string, options: any) {
            createdDirs.push(name);
            assert.strictEqual(options.create, true);
            return {
                name,
                async getDirectoryHandle(sub: string, subOpts: any) {
                    createdDirs.push(sub);
                    assert.strictEqual(subOpts.create, true);
                    return { name: sub };
                }
            };
        }
    };

    const finalSub = await ensureSubDir(mockRootHandle, 'assets/images');
    assert.deepStrictEqual(createdDirs, ['assets', 'images']);
    assert.strictEqual(finalSub.name, 'images');

    assert.throws(() => {
        new FsWriter(null as any);
    }, /Directory handle is required for FsWriter/);

    const deniedHandle = {
        queryPermission: async () => 'denied',
        requestPermission: async () => 'denied'
    };
    const deniedWriter = new FsWriter(deniedHandle);
    await assert.rejects(async () => {
        await deniedWriter.init();
    }, /Directory permission not granted: denied/);
});

// ZipWriter
test('zipWriter - exports, instantiation, and sanitization', () => {
    assert.ok(ZipWriter);
    __setZipConstructor(class MockJSZip {
        files: Record<string, any> = {};
        constructor() { this.files = {}; }
        file(path: string, content: unknown, options?: unknown) { return this.legacyFolder('').file(path, content, options); }
        legacyFolder(_name: string) {
            return {
                file: (path: string, content: any, _options?: unknown) => { this.files[path] = content; }
            };
        }
        async generateAsync(_options?: any, cb?: (p: { percent: number }) => void) {
            if (cb) cb({ percent: 100 });
            return new Blob(['mock-zip'], { type: 'application/zip' });
        }
    });

    const writer = new ZipWriter();
    assert.ok(writer);
    assert.strictEqual(typeof writer.writeFile, 'function');
    assert.strictEqual(typeof writer.generateBlob, 'function');
    assert.strictEqual(typeof writer.sanitizePath, 'function');
    assert.throws(() => writer.sanitizePath('foo/../bar/test.md'), /Unsafe|Noncanonical/);
});

test('zipWriter - writeFile and generateBlob', async () => {
    const writer = new ZipWriter();
    writer.MAX_SAFE_ZIP_BYTES = 11;
    writer.writeFile('test.txt', 'Hello world');
    assert.throws(() => writer.writeFile('overflow.txt', '!'), /上限/);
    let progressReported = null;
    const blob = await writer.generateBlob((pct: any) => {
        progressReported = pct;
    });
    assert.ok(blob);
    assert.strictEqual(progressReported, 100);
});

test('zipWriter counts Blob bytes toward the safety limit', () => {
    const writer = new ZipWriter();
    writer.MAX_SAFE_ZIP_BYTES = 10;
    writer.writeFile('small.bin', new Blob([new Uint8Array(8)]));
    assert.throws(() => writer.writeFile('large.bin', new Blob([new Uint8Array(3)])), /上限/);
});

test('fsWriter - rejects invalid or empty plain object content before touching file handle', async () => {
    let fileHandleCreated = false;
    const mockDirHandle = {
        name: 'gemini_export',
        getFileHandle: async () => {
            fileHandleCreated = true;
            return {
                createWritable: async () => ({
                    write: async () => {},
                    close: async () => {},
                    abort: async () => {}
                })
            };
        }
    };

    const writer = new FsWriter(mockDirHandle);
    await writer.init();

    // Plain empty object from broken JSON serialization must throw and not create file handle
    await assert.rejects(async () => {
        await writer.writeFile('broken_image.jpg', {});
    }, /Invalid content object passed to writeFile/);
    assert.strictEqual(fileHandleCreated, false, 'Must not create file handle on disk for invalid object');

    // Null or undefined content must throw
    await assert.rejects(async () => {
        await writer.writeFile('null_file.md', null);
    }, /Cannot write null or undefined content/);
    assert.strictEqual(fileHandleCreated, false, 'Must not create file handle on disk for null');

    // Valid string or Uint8Array must succeed and call getFileHandle
    const okName = await writer.writeFile('valid.txt', 'Hello world');
    assert.strictEqual(okName, 'valid.txt');
    assert.strictEqual(fileHandleCreated, true);
});

test('zipWriter - isPrecompressedAsset identifies media vs text correctly', () => {
    assert.strictEqual(isPrecompressedAsset('photo.png'), true);
    assert.strictEqual(isPrecompressedAsset('image.JPG'), true);
    assert.strictEqual(isPrecompressedAsset('assets/graphic.webp'), true);
    assert.strictEqual(isPrecompressedAsset('audio.mp3'), true);
    assert.strictEqual(isPrecompressedAsset('video.mp4'), true);
    assert.strictEqual(isPrecompressedAsset('archive.zip'), true);
    assert.strictEqual(isPrecompressedAsset('doc.pdf'), true);

    assert.strictEqual(isPrecompressedAsset('chat.md'), false);
    assert.strictEqual(isPrecompressedAsset('data.json'), false);
    assert.strictEqual(isPrecompressedAsset('script.py'), false);
    assert.strictEqual(isPrecompressedAsset('index.html'), false);
    assert.strictEqual(isPrecompressedAsset(''), false);
});

test('zipWriter - selective compression uses STORE for media and DEFLATE for text', () => {
    const recordedOpts: Record<string, any> = {};
    __setZipConstructor(class MockJSZip {
        files: Record<string, any> = {};
        constructor() { this.files = {}; }
        file(path: string, content: unknown, options?: unknown) { return this.legacyFolder('').file(path, content, options); }
        legacyFolder(_name: string) {
            return {
                file: (path: string, content: any, opts: any) => {
                    this.files[path] = content;
                    recordedOpts[path] = opts;
                }
            };
        }
        async generateAsync() { return new Blob(['']); }
    });

    const writer = new ZipWriter();
    writer.writeFile('assets/picture.png', 'png_bytes');
    writer.writeFile('conversation.md', '# Chat content');

    assert.strictEqual(recordedOpts['assets/picture.png']?.compression, 'STORE');
    assert.strictEqual(recordedOpts['conversation.md']?.compression, 'DEFLATE');
});

test('zipWriter - generateBlob uses generateInternalStream when available', async () => {
    let internalStreamUsed = false;
    let asyncUsed = false;

    __setZipConstructor(class MockJSZipWithStream {
        file(path: string, content: unknown, options?: unknown) { return this.legacyFolder('').file(path, content, options); }
        legacyFolder(_name: string) {
            return { file: (_path?: string, _content?: unknown, _options?: unknown) => {} };
        }
        generateInternalStream(opts: any) {
            internalStreamUsed = true;
            assert.strictEqual(opts.type, 'blob');
            return {
                accumulate: async (onUpdate: any) => {
                    if (onUpdate) onUpdate({ percent: 100 });
                    return new Blob(['stream-zip']);
                }
            };
        }
        async generateAsync() {
            asyncUsed = true;
            return new Blob(['async-zip']);
        }
    });

    const writer = new ZipWriter();
    let pctReceived = 0;
    const blob = await writer.generateBlob((pct: number) => { pctReceived = pct; });

    assert.strictEqual(internalStreamUsed, true);
    assert.strictEqual(asyncUsed, false);
    assert.strictEqual(pctReceived, 100);
    assert.ok(blob);
});

test('zipWriter - passes (path, content, options) through to JSZip file()', () => {
    let capturedPath = '';
    let capturedContent: any = null;
    let capturedOpts: any = null;

    __setZipConstructor(class MockJSZip {
        files: Record<string, any> = {};
        constructor() { this.files = {}; }
        file(path: string, content: unknown, options?: unknown) { return this.legacyFolder('').file(path, content, options); }
        legacyFolder(_name: string) {
            return {
                file: (p: string, c: any, o: any) => {
                    capturedPath = p;
                    capturedContent = c;
                    capturedOpts = o;
                }
            };
        }
        async generateAsync() { return new Blob(['']); }
    });

    const writer = new ZipWriter();

    // Case 1: (path, content, options) where content is string (base64)
    writer.writeFile('files/config.json', 'eyJuYW1lIjoidGVzdCJ9', { base64: true });
    assert.strictEqual(capturedPath, 'files/config.json');
    assert.strictEqual(capturedContent, 'eyJuYW1lIjoidGVzdCJ9');
    assert.strictEqual(capturedOpts.base64, true);

    // (path, content) 2-arg with nested subdir
    writer.writeFile('assets/data.txt', 'hello-world');
    assert.strictEqual(capturedPath, 'assets/data.txt');
    assert.deepStrictEqual(capturedContent, new TextEncoder().encode('hello-world'));

    // (relativePath, content) 2-arg, no subdir
    writer.writeFile('00_INDEX.md', '# Index');
    assert.strictEqual(capturedPath, '00_INDEX.md');
    assert.deepStrictEqual(capturedContent, new TextEncoder().encode('# Index'));
});

test('fsWriter - writes via relativePath and decodes base64 correctly', async () => {
    let writtenData: any = null;
    let targetFileName = '';

    const mockDirHandle = {
        name: 'gemini_export',
        getDirectoryHandle: async () => mockDirHandle,
        getFileHandle: async (name: string) => {
            targetFileName = name;
            return {
                createWritable: async () => ({
                    write: async (d: any) => { writtenData = d; },
                    close: async () => {},
                    abort: async () => {}
                })
            };
        }
    };

    const writer = new FsWriter(mockDirHandle);
    await writer.init();

    // Base64 string for "hello" is "aGVsbG8="
    await writer.writeFile('files/hello.txt', 'aGVsbG8=', { base64: true });
    assert.strictEqual(targetFileName, 'hello.txt');
    assert.ok(writtenData instanceof Uint8Array);
    assert.strictEqual(Buffer.from(writtenData).toString('utf-8'), 'hello');

    // Subdir via relative path
    await writer.writeFile('assets/plain.txt', 'plain text');
    assert.strictEqual(targetFileName, 'plain.txt');
    assert.strictEqual(writtenData, 'plain text');
});

