/**
 * tests/pdf-sandbox-compiler.test.ts
 *
 * Tier 1 tests for the P1b sandbox compile container:
 * - postMessage protocol validation (bad origin / type / jobId are rejected)
 * - init stays offline: beforeBuild carries loadFonts([], {assets:false})
 * - MATH-table font gate: fontHasMathTable + stripConvertedMath
 * - cancellation: pre-aborted and mid-flight abort both surface
 *   DOMException 'AbortError'; cancel is signalled to the sandbox
 * - full fake-sandbox round trip: ready -> inited -> compiled wires jobIds,
 *   validates the %PDF- magic, and surfaces sandbox diagnostics
 */
export {};
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
    parseProtocolMessage,
    checkMessageSource,
    sandboxExpectedHostOrigin,
    HOST_MESSAGE_TYPES,
    SANDBOX_MESSAGE_TYPES,
    SANDBOX_OPAQUE_ORIGIN,
    SANDBOX_TO_HOST,
    HOST_TO_SANDBOX,
    BUNDLED_FONT_PATHS,
} = require('../src/core/export/typst/sandboxProtocol.js');

const { createOfflineInitOptions } = require('../src/ui/sandbox/offlineInit.js');

const {
    toTypstPayload,
} = require('../src/core/export/typst/payload.js');

const {
    TypstSandboxCompiler,
    fontHasMathTable,
    stripConvertedMath,
} = require('../src/core/export/typst/typstSandboxCompiler.js');

const tick = (n = 5) => new Promise((resolve) => {
    const step = () => (n <= 1 ? resolve(undefined) : (n -= 1, setImmediate(step)));
    step();
});

// ---------------------------------------------------------------------------
// Protocol validation
// ---------------------------------------------------------------------------

test('protocol: accepts a well-formed compile message', () => {
    const r = parseProtocolMessage(
        { type: 'typst/compile', jobId: 'j1', files: [] }, HOST_MESSAGE_TYPES);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.message.type, 'typst/compile');
    assert.strictEqual(r.message.jobId, 'j1');
});

test('protocol: rejects non-objects, missing/unknown types', () => {
    for (const bad of [null, 42, 'x', [], { jobId: 'j' }, { type: 7, jobId: 'j' }]) {
        const r = parseProtocolMessage(bad, HOST_MESSAGE_TYPES);
        assert.strictEqual(r.ok, false, `should reject ${JSON.stringify(bad)}`);
    }
    const unknown = parseProtocolMessage({ type: 'typst/bogus', jobId: 'j' }, HOST_MESSAGE_TYPES);
    assert.strictEqual(unknown.ok, false);
    assert.match(unknown.reason, /unknown message type/);
});

test('protocol: rejects missing/empty jobId on non-ready messages', () => {
    for (const msg of [
        { type: 'typst/compile' },
        { type: 'typst/compile', jobId: '' },
        { type: 'typst/compile', jobId: 42 },
        { type: 'typst/error', jobId: null },
    ]) {
        const r = parseProtocolMessage(msg, SANDBOX_MESSAGE_TYPES);
        assert.strictEqual(r.ok, false, `should reject ${JSON.stringify(msg)}`);
    }
});

test('protocol: ready broadcast carries no jobId', () => {
    const ok = parseProtocolMessage({ type: 'typst/ready' }, SANDBOX_MESSAGE_TYPES);
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(ok.message.jobId, null);
    const bad = parseProtocolMessage({ type: 'typst/ready', jobId: 'j' }, SANDBOX_MESSAGE_TYPES);
    assert.strictEqual(bad.ok, false);
});

test('protocol: source/origin gate requires both to match', () => {
    const win = {};
    assert.strictEqual(checkMessageSource({ source: win, origin: 'null' }, win, 'null'), true);
    assert.strictEqual(checkMessageSource({ source: win, origin: 'https://evil.example' }, win, 'null'), false);
    assert.strictEqual(checkMessageSource({ source: {}, origin: 'null' }, win, 'null'), false);
    assert.strictEqual(checkMessageSource({ source: win, origin: '' }, win, 'null'), false);
});

test('protocol: sandbox derives the expected host origin from its own URL', () => {
    assert.strictEqual(
        sandboxExpectedHostOrigin('chrome-extension://abcdefghijklmnop/src/ui/sandbox/typst-compile.html'),
        'chrome-extension://abcdefghijklmnop');
});

test('protocol: sandbox messages arrive with the opaque origin', () => {
    assert.strictEqual(SANDBOX_OPAQUE_ORIGIN, 'null');
    assert.ok(SANDBOX_MESSAGE_TYPES.has(SANDBOX_TO_HOST.READY));
    assert.ok(SANDBOX_MESSAGE_TYPES.has(SANDBOX_TO_HOST.COMPILED));
    assert.ok(SANDBOX_MESSAGE_TYPES.has(SANDBOX_TO_HOST.FONTS_INSTALLED));
    assert.ok(HOST_MESSAGE_TYPES.has(HOST_TO_SANDBOX.INIT));
    assert.ok(HOST_MESSAGE_TYPES.has(HOST_TO_SANDBOX.CANCEL));
});

test('protocol: accepts a well-formed fonts-installed ACK', () => {
    const r = parseProtocolMessage(
        { type: 'typst/fonts-installed', jobId: 'j1' }, SANDBOX_MESSAGE_TYPES);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.message.type, 'typst/fonts-installed');
    assert.strictEqual(r.message.jobId, 'j1');
});

// ---------------------------------------------------------------------------
// Offline init: no remote font fetching, ever
// ---------------------------------------------------------------------------

test('init: beforeBuild disables typst.ts remote font assets', () => {
    const opts = createOfflineInitOptions(() => new Uint8Array(8));
    assert.strictEqual(typeof opts.getModule, 'function');
    assert.ok(Array.isArray(opts.beforeBuild) && opts.beforeBuild.length === 1);
    const remoteOptions = opts.beforeBuild[0]._preloadRemoteFontOptions;
    assert.ok(remoteOptions, 'loadFonts must stash its options for inspection');
    assert.strictEqual(remoteOptions.assets, false);
});

// ---------------------------------------------------------------------------
// MATH-table gate
// ---------------------------------------------------------------------------

function fakeFontBytes(withMath: boolean): Uint8Array {
    const tags = withMath ? ['MATH', 'head'] : ['head', 'maxp'];
    const buf = new ArrayBuffer(12 + tags.length * 16);
    const view = new DataView(buf);
    view.setUint32(0, 0x00010000);
    view.setUint16(4, tags.length);
    tags.forEach((tag, i) => {
        for (let k = 0; k < 4; k += 1) view.setUint8(12 + i * 16 + k, tag.charCodeAt(k));
    });
    return new Uint8Array(buf);
}

test('fontHasMathTable: detects the MATH table, rejects junk', () => {
    assert.strictEqual(fontHasMathTable(fakeFontBytes(true)), true);
    assert.strictEqual(fontHasMathTable(fakeFontBytes(false)), false);
    assert.strictEqual(fontHasMathTable(new Uint8Array(0)), false);
    assert.strictEqual(fontHasMathTable(new Uint8Array(11)), false);
    assert.strictEqual(fontHasMathTable(new Uint8Array(64)), false);
});

test('fontHasMathTable: the bundled NewCMMath really has a MATH table', () => {
    const fontPath = path.join(__dirname, '..', 'src', 'ui', 'sandbox', 'fonts', 'NewCMMath-Regular.otf');
    const bytes = new Uint8Array(fs.readFileSync(fontPath));
    assert.ok(bytes.length > 1_000_000, 'bundled font should be the full NewCMMath file');
    assert.strictEqual(fontHasMathTable(bytes), true);
});

test('stripConvertedMath: removes typst fields, keeps latex', () => {
    const doc: any = {
        schemaVersion: 1, title: 't', provider: 'gemini', date: '2026-09-26', messageCount: 1,
        messages: [{
            id: 'm1', role: 'user', blocks: [
                { type: 'math', latex: 'x^2', typst: 'x^2' },
                {
                    type: 'paragraph', children: [
                        { type: 'text', text: 'a' },
                        { type: 'inlineMath', latex: 'y', typst: 'y' },
                        { type: 'strong', children: [{ type: 'inlineMath', latex: 'z', typst: 'z' }] },
                    ],
                },
                {
                    type: 'table', headers: [[{ children: [{ type: 'text', text: 'h' }] }]],
                    rows: [[{ children: [{ type: 'inlineMath', latex: 'w', typst: 'w' }] }]],
                },
            ],
        }],
    };
    const stripped = stripConvertedMath(doc);
    assert.strictEqual(stripped, 4);
    assert.strictEqual('typst' in doc.messages[0].blocks[0], false);
    assert.strictEqual(doc.messages[0].blocks[0].latex, 'x^2');
    const paraChildren = doc.messages[0].blocks[1].children;
    assert.strictEqual('typst' in paraChildren[1], false);
    assert.strictEqual('typst' in paraChildren[2].children[0], false);
    assert.strictEqual('typst' in doc.messages[0].blocks[2].rows[0][0].children[0], false);
});

// ---------------------------------------------------------------------------
// Fake sandbox host for compiler tests
// ---------------------------------------------------------------------------

function makeBundle(extra: any = {}) {
    return {
        schemaVersion: 1,
        conversation: {
            key: { providerId: 'gemini', accountId: 'test-account', conversationId: 'c1' },
            title: 'Test convo',
            createdAt: '2026-09-20T10:00:00Z',
            messages: [
                { id: 'm1', role: 'user', blocks: [{ type: 'paragraph', children: [{ type: 'text', text: 'hi' }] }] },
                { id: 'm2', role: 'assistant', blocks: [{ type: 'paragraph', children: [{ type: 'text', text: 'hello' }] }] },
            ],
        },
        assets: [],
        citations: [],
        ...extra,
    };
}

function assetPathFor(asset: any) {
    const name = asset.name ?? '';
    const dot = name.lastIndexOf('.');
    const ext = dot >= 0 && dot < name.length - 1 ? name.slice(dot) : '';
    return `assets/${asset.id}${ext}`;
}

function makePayload(bundle: any, opts: { convertMath?: (source: string, display: boolean) => string | undefined } = {}) {
    const { payload: document } = toTypstPayload(bundle, {
        assetPath: assetPathFor,
        ...(opts.convertMath ? { convertMath: opts.convertMath } : {}),
    });
    return {
        rendererSchemaVersion: 1,
        sourceSchemaVersion: 1,
        bundle,
        document,
        assetPaths: new Map((bundle.assets ?? []).map((asset: any) => [asset.id, assetPathFor(asset)])),
    };
}

function makeContext(signal: AbortSignal, assets?: any) {
    return {
        bundle: null as any, // replaced below; kept for shape clarity
        assets: assets ?? { resolve: async () => null },
        locale: 'en' as const,
        signal,
        reportProgress: () => undefined,
    };
}

class FakeFrame {
    contentWindow: unknown = {};
    sent: Array<{ message: any; transfer?: Transferable[] }> = [];
    handlers: Array<(event: any) => void> = [];
    destroyed = false;
    postToSandbox(message: any, transfer?: Transferable[]) {
        this.sent.push({ message, transfer });
    }
    onMessage(handler: (event: any) => void) {
        this.handlers.push(handler);
        return () => undefined;
    }
    destroy() {
        this.destroyed = true;
    }
    receive(data: unknown, origin = 'null', source?: unknown) {
        for (const h of this.handlers) h({ source: source ?? this.contentWindow, origin, data });
    }
    lastSentType(type: string) {
        return this.sent.filter((s) => s.message.type === type).at(-1);
    }
}

class FakeHost {
    frame: FakeFrame | null = null;
    createdUrls: string[] = [];
    constructor(
        public wasmBytes: Uint8Array = new Uint8Array([0, 1, 2, 3]),
        public fontBytes: Uint8Array = fakeFontBytes(true),
    ) {}
    pageUrl() {
        return 'chrome-extension://fake-ext-id/src/ui/sandbox/typst-compile.html';
    }
    assetUrl(relativePath: string) {
        return `chrome-extension://fake-ext-id/${relativePath}`;
    }
    async fetchBytes(url: string) {
        if (url.endsWith('.wasm')) return this.wasmBytes;
        return this.fontBytes;
    }
    createFrame(url: string) {
        this.createdUrls.push(url);
        this.frame = new FakeFrame();
        return this.frame;
    }
}

function makeCompiler(host: FakeHost, extra: any = {}) {
    const compiler = new TypstSandboxCompiler({
        host: host as any,
        initTimeoutMs: 2000,
        compileTimeoutMs: 2000,
        ...extra,
    });
    return compiler;
}

async function driveInitHandshake(host: FakeHost): Promise<string> {
    for (let i = 0; i < 50 && !host.frame; i += 1) await tick(1);
    const frame = host.frame!;
    assert.ok(frame, 'sandbox frame should be created');
    frame.receive({ type: 'typst/ready' });
    await tick();
    const init = frame.lastSentType('typst/init')!;
    assert.ok(init, 'expected an init message after ready');
    assert.ok(init.message.wasm instanceof ArrayBuffer, 'wasm must cross as a transferred ArrayBuffer');
    frame.receive({ type: 'typst/inited', jobId: init.message.jobId, initMs: 12 });
    await tick();
    return init.message.jobId;
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

test('compile: pre-aborted signal rejects with AbortError before touching the sandbox', async () => {
    const host = new FakeHost();
    const compiler = makeCompiler(host);
    const controller = new AbortController();
    controller.abort();
    const context = { ...makeContext(controller.signal), bundle: makeBundle() };
    await assert.rejects(
        compiler.compile(makePayload(context.bundle), context),
        (e: any) => e instanceof DOMException && e.name === 'AbortError');
    assert.strictEqual(host.createdUrls.length, 0, 'no frame should be created after abort');
    compiler.dispose();
});

test('compile: mid-flight abort rejects with AbortError and notifies the sandbox', async () => {
    const host = new FakeHost();
    const compiler = makeCompiler(host);
    const controller = new AbortController();
    const bundle = makeBundle();
    const context = { ...makeContext(controller.signal), bundle };
    const promise = compiler.compile(makePayload(bundle), context);
    await driveInitHandshake(host);
    await tick();
    const compileMsg = host.frame!.lastSentType('typst/compile')!;
    assert.ok(compileMsg, 'expected a compile message after init');
    controller.abort();
    await assert.rejects(promise, (e: any) => e instanceof DOMException && e.name === 'AbortError');
    const cancel = host.frame!.lastSentType('typst/cancel');
    assert.ok(cancel, 'sandbox must be told about the cancellation');
    assert.strictEqual(cancel!.message.jobId, compileMsg.message.jobId);
    compiler.dispose();
    assert.strictEqual(host.frame!.destroyed, true);
});

// ---------------------------------------------------------------------------
// Full fake-sandbox round trip
// ---------------------------------------------------------------------------

test('compile: missing document rejects loudly instead of converting the bundle internally', async () => {
    const host = new FakeHost();
    const compiler = makeCompiler(host);
    const controller = new AbortController();
    const bundle = makeBundle();
    await assert.rejects(
        compiler.compile(
            { rendererSchemaVersion: 1, sourceSchemaVersion: 1, bundle } as any,
            { ...makeContext(controller.signal), bundle },
        ),
        /requires a prebuilt Typst document payload/,
    );
    assert.strictEqual(host.frame, null, 'no sandbox frame should be created');
    compiler.dispose();
});

test('compile: happy path returns PDF bytes and sandbox diagnostics', async () => {
    const host = new FakeHost();
    const compiler = makeCompiler(host);
    const controller = new AbortController();
    const bundle = makeBundle();
    const seen: string[] = [];
    const context = {
        ...makeContext(controller.signal), bundle,
        reportProgress: (stage: string) => { seen.push(stage); },
    };
    const promise = compiler.compile(makePayload(bundle), context);
    await driveInitHandshake(host);
    await tick();
    const compileMsg = host.frame!.lastSentType('typst/compile')!;
    assert.ok(compileMsg);
    // Fonts cross only on the first compile.
    assert.strictEqual(compileMsg.message.fonts.length, BUNDLED_FONT_PATHS.length);
    assert.ok(compileMsg.message.fonts[0] instanceof ArrayBuffer);
    assert.strictEqual(compileMsg.message.files[0].path, '/payload.json');
    const sentPayload = JSON.parse(compileMsg.message.files[0].text);
    assert.strictEqual(sentPayload.title, 'Test convo');
    assert.strictEqual(sentPayload.messageCount, 2);

    const pdfBytes = new TextEncoder().encode('%PDF-1.7\n%fake\n');
    // The real sandbox ACKs the font install before compiling; the fake
    // must do the same or the host (correctly) resends fonts next time.
    host.frame!.receive({ type: 'typst/fonts-installed', jobId: compileMsg.message.jobId });
    await tick();
    host.frame!.receive({
        type: 'typst/compiled',
        jobId: compileMsg.message.jobId,
        pdf: pdfBytes.buffer,
        diagnostics: [{ severity: 'warning', message: 'overfull box' }],
    });
    const result = await promise;
    assert.ok(result.pdfBytes instanceof Uint8Array);
    assert.strictEqual(String.fromCharCode(...result.pdfBytes.slice(0, 5)), '%PDF-');
    const codes = result.diagnostics.map((d: any) => d.code);
    assert.ok(codes.includes('TYPST_DIAGNOSTIC'), `diagnostics: ${JSON.stringify(codes)}`);
    assert.ok(seen.includes('typst-done'));

    // Second compile reuses the frame and skips the font install.
    const promise2 = compiler.compile(makePayload(bundle), { ...makeContext(controller.signal), bundle });
    await tick(10);
    const compileMsg2 = host.frame!.lastSentType('typst/compile')!;
    assert.strictEqual(compileMsg2.message.fonts.length, 0, 'fonts must be installed exactly once');
    controller.abort();
    await assert.rejects(promise2, (e: any) => e instanceof DOMException && e.name === 'AbortError');
    compiler.dispose();
});

test('compile: non-PDF bytes are refused, never returned', async () => {
    const host = new FakeHost();
    const compiler = makeCompiler(host);
    const controller = new AbortController();
    const bundle = makeBundle();
    const promise = compiler.compile(makePayload(bundle), { ...makeContext(controller.signal), bundle });
    await driveInitHandshake(host);
    await tick();
    const compileMsg = host.frame!.lastSentType('typst/compile')!;
    host.frame!.receive({
        type: 'typst/compiled',
        jobId: compileMsg.message.jobId,
        pdf: new TextEncoder().encode('not a pdf').buffer,
        diagnostics: [],
    });
    await assert.rejects(promise, /do not start with %PDF-/);
    compiler.dispose();
});

test('compile: sandbox error replies propagate as errors', async () => {
    const host = new FakeHost();
    const compiler = makeCompiler(host);
    const controller = new AbortController();
    const bundle = makeBundle();
    const promise = compiler.compile(makePayload(bundle), { ...makeContext(controller.signal), bundle });
    await driveInitHandshake(host);
    await tick();
    const compileMsg = host.frame!.lastSentType('typst/compile')!;
    host.frame!.receive({
        type: 'typst/error',
        jobId: compileMsg.message.jobId,
        error: { name: 'Error', message: 'typst: expected }' },
    });
    await assert.rejects(promise, /expected \}/);
    compiler.dispose();
});

test('compile: messages with bad origin or unknown jobId are ignored', async () => {
    const host = new FakeHost();
    const compiler = makeCompiler(host);
    const controller = new AbortController();
    const bundle = makeBundle();
    const promise = compiler.compile(makePayload(bundle), { ...makeContext(controller.signal), bundle });
    for (let i = 0; i < 50 && !host.frame; i += 1) await tick(1);
    assert.ok(host.frame, 'sandbox frame should be created');
    // Evil origin: the ready broadcast must not be accepted.
    host.frame!.receive({ type: 'typst/ready' }, 'https://evil.example');
    await tick();
    assert.strictEqual(host.frame!.lastSentType('typst/init'), undefined);
    // Unknown jobId compiled reply: ignored, no crash.
    host.frame!.receive(
        { type: 'typst/compiled', jobId: 'nope', pdf: null, diagnostics: [] });
    await tick();
    controller.abort();
    await assert.rejects(promise, (e: any) => e instanceof DOMException && e.name === 'AbortError');
    compiler.dispose();
});

test('compile: without a MATH font, converted math is stripped with a diagnostic', async () => {
    const host = new FakeHost(new Uint8Array([0, 1, 2, 3]), fakeFontBytes(false));
    const compiler = makeCompiler(host);
    const controller = new AbortController();
    const bundle = makeBundle();
    bundle.conversation.messages[0].blocks.push({ type: 'math', source: 'x^2' });
    const promise = compiler.compile(
        makePayload(bundle, { convertMath: () => 'x^2' }),
        { ...makeContext(controller.signal), bundle },
    );
    await driveInitHandshake(host);
    await tick();
    const compileMsg = host.frame!.lastSentType('typst/compile')!;
    const sentPayload = JSON.parse(compileMsg.message.files[0].text);
    const mathBlock = sentPayload.messages[0].blocks.find((b: any) => b.type === 'math');
    assert.ok(mathBlock, 'math block should survive as a payload node');
    assert.strictEqual(mathBlock.typst, undefined, 'typst field must be stripped without a MATH font');
    assert.strictEqual(mathBlock.latex, 'x^2', 'latex source must be preserved');
    controller.abort();
    await assert.rejects(promise, (e: any) => e instanceof DOMException && e.name === 'AbortError');
    compiler.dispose();
});

// ---------------------------------------------------------------------------
// Inline image bytes reach the sandbox (collectImagePaths covers image nodes)
// ---------------------------------------------------------------------------

test('compile: inline image asset bytes are mounted as shadow files', async () => {
    const host = new FakeHost();
    const compiler = makeCompiler(host);
    const controller = new AbortController();
    const bundle = makeBundle({
        assets: [{ id: 'a1', kind: 'image', name: 'pic.png', mimeType: 'image/png' }],
    });
    bundle.conversation.messages[0].blocks = [{
        type: 'paragraph',
        children: [
            { type: 'text', text: 'see ' },
            { type: 'image', assetId: 'a1', alt: 'diagram' },
            { type: 'strong', children: [{ type: 'image', assetId: 'a1', alt: 'nested' }] },
        ],
    }];
    const imageBytes = new Uint8Array([137, 80, 78, 71]);
    const assets = { resolve: async (id: any) => (id === 'a1' ? { bytes: imageBytes } : null) };
    const promise = compiler.compile(makePayload(bundle), { ...makeContext(controller.signal, assets), bundle });
    await driveInitHandshake(host);
    await tick();
    const compileMsg = host.frame!.lastSentType('typst/compile')!;
    assert.ok(compileMsg, 'expected a compile message after init');
    const binaries = compileMsg.message.binaries;
    assert.ok(Array.isArray(binaries), 'compile message must carry binaries');
    const paths = binaries.map((b: any) => b.path);
    assert.ok(paths.includes('assets/a1.png'), `inline image path must be mounted, got ${JSON.stringify(paths)}`);
    const mounted = binaries.find((b: any) => b.path === 'assets/a1.png');
    assert.ok(mounted.buf instanceof ArrayBuffer, 'image bytes must cross as a transferred ArrayBuffer');
    assert.deepStrictEqual(new Uint8Array(mounted.buf), imageBytes);
    // No bogus placeholder diagnostic for a successfully mounted image.
    controller.abort();
    await assert.rejects(promise, (e: any) => e instanceof DOMException && e.name === 'AbortError');
    compiler.dispose();
});

// ---------------------------------------------------------------------------
// Font install state is ACK-driven, not compile-outcome-driven
// ---------------------------------------------------------------------------

test('compile: fonts are not resent after a failed compile once installed', async () => {
    const host = new FakeHost();
    const compiler = makeCompiler(host);
    const controller = new AbortController();
    const bundle = makeBundle();
    const promise = compiler.compile(makePayload(bundle), { ...makeContext(controller.signal), bundle });
    await driveInitHandshake(host);
    await tick();
    const compileMsg = host.frame!.lastSentType('typst/compile')!;
    assert.ok(compileMsg, 'expected a compile message after init');
    assert.strictEqual(compileMsg.message.fonts.length, BUNDLED_FONT_PATHS.length, 'first compile ships fonts');
    // Sandbox installs fonts, ACKs, then the document compile fails.
    host.frame!.receive({ type: 'typst/fonts-installed', jobId: compileMsg.message.jobId });
    await tick();
    host.frame!.receive({
        type: 'typst/error',
        jobId: compileMsg.message.jobId,
        error: { name: 'Error', message: 'typst: file not found' },
    });
    await assert.rejects(promise, /file not found/);
    // Next compile must NOT resend fonts: the install was already ACKed.
    const promise2 = compiler.compile(makePayload(bundle), { ...makeContext(controller.signal), bundle });
    await tick(10);
    const compileMsg2 = host.frame!.lastSentType('typst/compile')!;
    assert.ok(compileMsg2, 'expected a second compile message');
    assert.strictEqual(
        compileMsg2.message.fonts.length, 0,
        'fonts must not be resent after FONTS_INSTALLED, even though the previous compile failed');
    controller.abort();
    await assert.rejects(promise2, (e: any) => e instanceof DOMException && e.name === 'AbortError');
    compiler.dispose();
});

async function compileOnce(host: FakeHost, compiler: any, compiledExtras: Record<string, unknown> = {}) {
    const bundle = makeBundle();
    const controller = new AbortController();
    const promise = compiler.compile(makePayload(bundle), { ...makeContext(controller.signal), bundle });
    await driveInitHandshake(host);
    await tick();
    const compileMsg = host.frame!.lastSentType('typst/compile')!;
    assert.ok(compileMsg, 'expected a compile message');
    host.frame!.receive({ type: 'typst/fonts-installed', jobId: compileMsg.message.jobId });
    await tick();
    host.frame!.receive({
        type: 'typst/compiled',
        jobId: compileMsg.message.jobId,
        pdf: new TextEncoder().encode('%PDF-1.7\n%fake\n').buffer,
        diagnostics: [],
        ...compiledExtras,
    });
    const result = await promise;
    compiler.dispose();
    return result;
}

test('math gate: runtime fonts without MATH plus a MATH-capable font raise no MATH warnings', async () => {
    const host = new FakeHost(new Uint8Array([0, 1, 2, 3]), fakeFontBytes(false));
    const compiler = makeCompiler(host);
    compiler.setRuntimeFonts([fakeFontBytes(true)]);
    const result = await compileOnce(host, compiler, { fontsMissingMath: [0] });
    const codes = result.diagnostics.map((d: any) => d.code);
    assert.ok(!codes.includes('TYPST_FONT_MISSING_MATH_TABLE'), `unexpected: ${JSON.stringify(codes)}`);
    assert.ok(!codes.includes('TYPST_MATH_TABLE_MISSING'), `unexpected: ${JSON.stringify(codes)}`);
});

test('math gate: no loaded font with a MATH table keeps the aggregate warning', async () => {
    const host = new FakeHost(new Uint8Array([0, 1, 2, 3]), fakeFontBytes(false));
    const compiler = makeCompiler(host);
    const result = await compileOnce(host, compiler);
    const codes = result.diagnostics.map((d: any) => d.code);
    assert.ok(codes.includes('TYPST_MATH_TABLE_MISSING'), `diagnostics: ${JSON.stringify(codes)}`);
});
