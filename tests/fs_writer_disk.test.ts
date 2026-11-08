export {};
const test = require('node:test');
const assert = require('node:assert');

const { FsWriter } = require('../src/l4/delivery/writers/fsWriter.js');

// FsWriter owns the folder, relative-path routing, writable lifecycle and bytes.
// Conversation filename selection/cid6 is an upstream contract covered by
// buildExportFileName tests; recomputing cid6 here would only test the fixture.
test('fsWriter - writes supplied conversation and asset paths under export folder', async () => {
    const written: Record<string, unknown> = {};
    let closeCount = 0;
    const directory = (prefix: string): any => ({
        name: 'MyVault',
        getDirectoryHandle: async (folder: string) => directory(prefix + folder + '/'),
        getFileHandle: async (file: string) => ({ createWritable: async () => ({
            write: async (content: unknown) => { written[prefix + file] = content; },
            close: async () => { closeCount++; }, abort: async () => {},
        }) }),
    });
    const mockDir = directory('');

    const writer = new FsWriter(mockDir);
    await writer.init();

    const markdown = '# Quantum Computing\n\nContent';
    const imageBytes = new Uint8Array([1, 2, 3]);
    const markdownReceipt = await writer.writeFile('Quantum Computing_abcdef.md', markdown);
    const assetReceipt = await writer.writeFile('assets/abcdef_t1_img1.png', imageBytes);

    assert.strictEqual(markdownReceipt, 'Quantum Computing_abcdef.md');
    assert.strictEqual(assetReceipt, 'assets/abcdef_t1_img1.png');
    assert.deepStrictEqual(Object.keys(written).sort(), [
        'Quantum Computing_abcdef.md',
        'assets/abcdef_t1_img1.png',
    ].sort());
    assert.strictEqual(written['Quantum Computing_abcdef.md'], markdown);
    assert.deepStrictEqual(written['assets/abcdef_t1_img1.png'], imageBytes);
    assert.strictEqual(closeCount, 2, 'both successful writes must close their file handles');
});

test('fsWriter - invokes abort() on writable when write operation fails', async () => {
    let abortCalled = false;
    let closeCalled = false;
    const mockDir = {
        name: 'MyVault',
        getFileHandle: async () => ({
                createWritable: async () => ({
                    write: async () => {
                        throw new Error('Simulated disk full during write');
                    },
                    close: async () => { closeCalled = true; },
                    abort: async () => { abortCalled = true; }
                })
            })
    };

    const writer = new FsWriter(mockDir);
    await writer.init();

    await assert.rejects(
        writer.writeFile('broken.md', 'some content'),
        /Simulated disk full during write/
    );

    assert.strictEqual(abortCalled, true, 'abort() must be called when write throws');
    assert.strictEqual(closeCalled, false, 'close() must not be called when write throws');
});


for (const persistent of [false, true]) test(`fsWriter - stale snapshot retry is bounded (persistent=${persistent})`, async () => {
    let opened = 0;
    let aborted = 0;
    let writes = 0;
    const writer = new FsWriter({
        getFileHandle: async () => {
            opened++;
            return { createWritable: async () => ({
                write: async () => { writes++; },
                close: async () => {
                    if (persistent || opened === 1) throw new DOMException('Stale disk state', 'InvalidStateError');
                },
                abort: async () => { aborted++; },
            }) };
        },
    });
    if (persistent) await assert.rejects(writer.writeFile('chat.md', 'body'), (error: unknown) => {
        if (!(error instanceof Error)) return false;
        assert.match(error.message, /File close failed for chat\.md \[InvalidStateError\]: Stale disk state/);
        assert.match(error.message, /"permission":"unsupported"/);
        assert.match(error.message, /"attemptErrors":\["close:InvalidStateError","close:InvalidStateError","close:InvalidStateError"\]/);
        assert.match(error.message, /"fileNameUtf8Bytes":7/);
        assert.match(error.message, /U\+63/);
        return true;
    });
    else assert.equal(await writer.writeFile('chat.md', 'body'), 'chat.md');
    assert.equal(opened, persistent ? 3 : 2);
    assert.equal(writes, opened);
    assert.equal(aborted, persistent ? 3 : 1);
});

test('Folder delivery overlaps distinct files with a bounded pool but preserves duplicate-path order', async () => {
    const { writeToFolder } = require('../src/l4/delivery/index.js');
    const writes: Array<{ name: string; content: unknown }> = [];
    let active = 0;
    let maximum = 0;
    const directory = {
        queryPermission: async () => 'granted',
        getFileHandle: async (name: string) => ({ createWritable: async () => ({
            write: async (content: unknown) => {
                active++;
                maximum = Math.max(maximum, active);
                await new Promise<void>(resolve => setImmediate(resolve));
                writes.push({ name, content });
                active--;
            },
            close: async () => {},
            abort: async () => {},
        }) }),
    };
    const files = [
        { fileName: 'a.txt', content: 'first', mimeType: 'text/plain' },
        { fileName: 'b.txt', content: 'b', mimeType: 'text/plain' },
        { fileName: 'c.txt', content: 'c', mimeType: 'text/plain' },
        { fileName: 'a.txt', content: 'second', mimeType: 'text/plain' },
        { fileName: 'd.txt', content: 'd', mimeType: 'text/plain' },
    ];
    await writeToFolder(files, directory);
    assert.equal(maximum, 3, 'file writes should overlap but stay bounded');
    assert.equal(active, 0);
    assert.equal(writes.length, 5);
    assert.deepStrictEqual(writes.filter(write => write.name === 'a.txt').map(write => write.content),
        ['first', 'second'], 'same-path writes must retain their input order');
});

test('Folder delivery drains in-flight writes before rejecting and stops scheduling new files', async () => {
    const { writeToFolder } = require('../src/l4/delivery/index.js');
    const started: string[] = [];
    let active = 0;
    const directory = {
        queryPermission: async () => 'granted',
        getFileHandle: async (name: string) => ({ createWritable: async () => ({
            write: async () => {
                started.push(name);
                active++;
                try {
                    await new Promise<void>(resolve => setImmediate(resolve));
                    if (name === 'fail.txt') throw new Error('disk full');
                } finally { active--; }
            },
            close: async () => {},
            abort: async () => {},
        }) }),
    };
    await assert.rejects(writeToFolder(['fail.txt', 'b.txt', 'c.txt', 'later.txt'].map(fileName =>
        ({ fileName, content: fileName, mimeType: 'text/plain' })), directory), /disk full/);
    assert.equal(active, 0, 'no writable may remain active after rejection');
    assert.ok(!started.includes('later.txt'), 'failed delivery should stop scheduling further files');
});
