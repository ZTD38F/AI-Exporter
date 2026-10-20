export {};
const test = require('node:test');
const assert = require('node:assert');

const { FsWriter } = require('../src/core/engine/writers/fsWriter.js');

// Ported from tests/e2e/live_save.spec.ts ("should write live save files to
// gemini_export folder with cid6 filename matching manual export").
// That e2e case read the writer class off window.FsWriter; the mount is gone,
// and the case never needed a browser at all (the directory handle is fully
// mocked), so it now runs as a plain Node unit test.

// ---------------------------------------------------------------------------
// FsWriter disk layout: cid6 filenames under gemini_export/
// ---------------------------------------------------------------------------
test('fsWriter - disk layout uses cid6 filenames under gemini_export folder', async () => {
    const written: Record<string, any> = {};
    const mockDir = {
        name: 'MyVault',
        getDirectoryHandle: async (folder: string) => ({
            name: folder,
            getFileHandle: async (file: string) => ({
                createWritable: async () => ({
                    write: async (content: any) => { written[`${folder}/${file}`] = content; },
                    close: async () => {},
                    abort: async () => {}
                })
            }),
            getDirectoryHandle: async (subFolder: string) => ({
                name: subFolder,
                getFileHandle: async (assetFile: string) => ({
                    createWritable: async () => ({
                        write: async (content: any) => { written[`${folder}/${subFolder}/${assetFile}`] = content; },
                        close: async () => {},
                        abort: async () => {}
                    })
                })
            })
        })
    };

    const writer = new FsWriter(mockDir, 'gemini_export');
    await writer.init();

    // Write markdown with cid6
    const cid = 'c_0123456789abcdef';
    const cid6 = cid.replace(/^c_/, '').slice(-6);
    const fileName = `Quantum Computing_${cid6}.md`;
    await writer.writeFile(fileName, '# Quantum Computing\n\nContent');

    // Write asset into assets/
    await writer.writeFile(`assets/${cid6}_t1_img1.png`, new Uint8Array([1, 2, 3]));

    assert.strictEqual(cid6, 'abcdef');
    assert.strictEqual(fileName, 'Quantum Computing_abcdef.md');
    assert.ok(
        Object.keys(written).includes('gemini_export/Quantum Computing_abcdef.md'),
        `expected markdown under gemini_export/, got: ${Object.keys(written).join(', ')}`
    );
    assert.ok(
        Object.keys(written).includes('gemini_export/assets/abcdef_t1_img1.png'),
        `expected asset under gemini_export/assets/, got: ${Object.keys(written).join(', ')}`
    );
});

test('fsWriter - invokes abort() on writable when write operation fails', async () => {
    let abortCalled = false;
    let closeCalled = false;
    const mockDir = {
        name: 'MyVault',
        getDirectoryHandle: async () => ({
            getFileHandle: async () => ({
                createWritable: async () => ({
                    write: async () => {
                        throw new Error('Simulated disk full during write');
                    },
                    close: async () => { closeCalled = true; },
                    abort: async () => { abortCalled = true; }
                })
            })
        })
    };

    const writer = new FsWriter(mockDir, 'gemini_export');
    await writer.init();

    await assert.rejects(
        writer.writeFile('broken.md', 'some content'),
        /Simulated disk full during write/
    );

    assert.strictEqual(abortCalled, true, 'abort() must be called when write throws');
    assert.strictEqual(closeCalled, false, 'close() must not be called when write throws');
});

