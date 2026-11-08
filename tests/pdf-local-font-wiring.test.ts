import { fixtureKey, fixtureAccountFor } from './helpers/domainFixture.js';
export {};
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { TypstSandboxCompiler } = require('../src/l4/format/pdf/typst/typstSandboxCompiler.js');
const { composeDomainDocument } = require('../src/l3b/compose/composeDomainDocument.js');
const { renderTypstFixture } = require('./helpers/renderTypstFixture.js');
const {
    resolveLocalFonts,
    clearLocalFontCache,
    BUNDLED_MATH_FALLBACK,
    BUNDLED_TEXT_FALLBACK,
    SYSTEM_FALLBACK,
} = require('../src/l4/format/pdf/typst/fonts/localFontProvider.js');
const { mountRuntimeFonts } = require('../src/l4/format/pdf/typst/fonts/mountRuntimeFonts.js');
const { extractPdfText } = require('./helpers/pdfTextExtract.js');
const { probePdfLayout } = require('./helpers/pdfPageProbe.js');
const {
    RealWasmSandboxHost,
    repoRoot,
    resolveLocalCjkFont,
} = require('./helpers/realWasmSandbox.js');

const tick = (n = 5) =>
    new Promise((resolve) => {
        const step = () => (n <= 1 ? resolve(undefined) : ((n -= 1), setImmediate(step)));
        step();
    });

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

function fakeEntry(
    family: string,
    postscriptName: string,
    bytes: Uint8Array,
    hooks: { onBlob?: () => void; throws?: boolean } = {},
) {
    return {
        family,
        fullName: `${family} Regular`,
        postscriptName,
        style: 'Regular',
        blob: async () => {
            hooks.onBlob?.();
            if (hooks.throws) throw new Error('blob denied');
            return new Blob([Buffer.from(bytes)]);
        },
    };
}

const KNOWN_BYTES = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);

function mockQueryLocalFonts(entries: unknown[]) {
    clearLocalFontCache();
    const prev = (globalThis as any).queryLocalFonts;
    (globalThis as any).queryLocalFonts = async () => entries;
    return () => {
        clearLocalFontCache();
        if (prev === undefined) delete (globalThis as any).queryLocalFonts;
        else (globalThis as any).queryLocalFonts = prev;
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
    constructor(public fontBytes: Uint8Array = fakeFontBytes(true)) {}
    pageUrl() {
        return 'chrome-extension://fake-ext-id/src/l4/format/pdf/sandbox/typst-compile.html';
    }
    assetUrl(relativePath: string) {
        return `chrome-extension://fake-ext-id/${relativePath}`;
    }
    async fetchBytes(url: string) {
        if (url.endsWith('.wasm')) return new Uint8Array([0, 1, 2, 3]);
        return this.fontBytes;
    }
    createFrame(_url: string) {
        this.frame = new FakeFrame();
        return this.frame;
    }
}

function makeCompiler(host: FakeHost) {
    return new TypstSandboxCompiler({
        host: host as any,
        initTimeoutMs: 5000,
        compileTimeoutMs: 5000,
    });
}

async function driveInitHandshake(host: FakeHost) {
    for (let i = 0; i < 50 && !host.frame; i += 1) await tick(1);
    const frame = host.frame!;
    assert.ok(frame, 'sandbox frame should be created');
    frame.receive({ type: 'typst/ready' });
    await tick();
    const init = frame.lastSentType('typst/init')!;
    assert.ok(init, 'expected an init message after ready');
    frame.receive({ type: 'typst/inited', jobId: init.message.jobId, initMs: 12 });
    await tick();
}

function fakePdfBuffer(): ArrayBuffer {
    return new TextEncoder().encode('%PDF-1.7\n%fake\n').buffer as ArrayBuffer;
}

async function driveCompileRoundTrip(host: FakeHost): Promise<any> {
    await tick(10);
    const compileMsg = host.frame!.lastSentType('typst/compile')!;
    assert.ok(compileMsg, 'expected a compile message');
    host.frame!.receive({ type: 'typst/fonts-installed', jobId: compileMsg.message.jobId });
    await tick();
    host.frame!.receive({
        type: 'typst/compiled',
        jobId: compileMsg.message.jobId,
        pdf: fakePdfBuffer(),
        diagnostics: [],
    });
    return compileMsg;
}

function makeDomain() {
    return { index: { key: fixtureKey(String('c1'), 'gemini'),   titleSource: "derived",   title: 'Test convo', createdAt: '2026-09-20T10:00:00Z' }, detail: { key: fixtureKey(String('c1'), 'gemini'), quality: { status: 'unknown' }, assets: [], messages: [
        { id: 'm1', role: 'user', content: [{ type: 'paragraph', children: [{ type: 'text', text: 'hi' }] }] },
        { id: 'm2', role: 'assistant', content: [{ type: 'paragraph', children: [{ type: 'text', text: 'hello' }] }] },
    ] } };
}

function makeContext(domain: any) {
    return {

        assets: { resolve: async () => null },
        locale: 'en' as const,
        signal: new AbortController().signal,
        reportProgress: () => undefined,
    };
}

function assetPathFor(asset: any) {
    const name = asset.name ?? '';
    const dot = name.lastIndexOf('.');
    const ext = dot >= 0 && dot < name.length - 1 ? name.slice(dot) : '';
    return `assets/${asset.id}${ext}`;
}

function makePayload(domain: any) {
    const { payload: document } = renderTypstFixture(composeDomainDocument(domain, fixtureAccountFor(domain)), Object.fromEntries(domain.detail.assets.map((asset: any) => [asset.id, assetPathFor(asset)])));
    return {
        rendererSchemaVersion: 1,


        document,
        assetPaths: new Map((domain.detail.assets ?? []).map((asset: any) => [asset.id, assetPathFor(asset)])),
    };
}

test('A: resolveLocalFonts -> mountRuntimeFonts -> sandbox receives the runtime font bytes', async () => {
    const restore = mockQueryLocalFonts([fakeEntry('Noto Sans CJK SC', 'NotoSansCJKSC-Regular', KNOWN_BYTES)]);
    try {
        const resolution = await resolveLocalFonts();
        assert.strictEqual(resolution.fonts.length, 1);
        assert.strictEqual(resolution.localFontsAvailable, true);

        const host = new FakeHost();
        const compiler = makeCompiler(host);
        const mounted = await mountRuntimeFonts(resolution, compiler);
        assert.strictEqual(mounted.mountedCount, 1);
        assert.deepStrictEqual(mounted.diagnostics, []);
        assert.ok(mounted.effectiveFonts.fallbackChain[0].startsWith('Noto Sans CJK SC (local,'));
        assert.strictEqual(mounted.effectiveFonts.localFontsAvailable, true);

        const domain = makeDomain();
        const promise = compiler.compile(makePayload(domain), makeContext(domain));
        await driveInitHandshake(host);
        const compileMsg = await driveCompileRoundTrip(host);
        const received = (compileMsg.message.fonts as ArrayBuffer[]).map((b) => Buffer.from(b));
        assert.ok(
            received.some((b) => b.equals(Buffer.from(KNOWN_BYTES))),
            'sandbox fonts[] must contain the runtime font bytes',
        );
        const result = await promise;
        assert.strictEqual(String.fromCharCode(...result.pdfBytes.slice(0, 5)), '%PDF-');
        compiler.dispose();
    } finally {
        restore();
    }
});

test('B: two compiles in one session read font bytes exactly once and install fonts once', async () => {
    let blobCalls = 0;
    const restore = mockQueryLocalFonts([
        fakeEntry('Noto Sans CJK SC', 'NotoSansCJKSC-Regular', KNOWN_BYTES, {
            onBlob: () => {
                blobCalls += 1;
            },
        }),
    ]);
    try {
        const resolution = await resolveLocalFonts();
        const host = new FakeHost();
        const compiler = makeCompiler(host);
        const mounted = await mountRuntimeFonts(resolution, compiler);
        assert.strictEqual(mounted.mountedCount, 1);

        const domain = makeDomain();
        const promise1 = compiler.compile(makePayload(domain), makeContext(domain));
        await driveInitHandshake(host);
        const compileMsg1 = await driveCompileRoundTrip(host);
        assert.ok(compileMsg1.message.fonts.length > 0, 'first compile carries fonts');
        await promise1;

        const promise2 = compiler.compile(makePayload(domain), makeContext(domain));
        const compileMsg2 = await driveCompileRoundTrip(host);
        assert.strictEqual(compileMsg2.message.fonts.length, 0, 'fonts must be installed exactly once');
        await promise2;

        assert.strictEqual(blobCalls, 1, 'font bytes must be read exactly once per session');
        compiler.dispose();
    } finally {
        restore();
    }
});

test('C: getBytes failure emits TYPST_LOCAL_FONT_READ_FAILED and the export continues', async () => {
    const restore = mockQueryLocalFonts([
        fakeEntry('Noto Sans CJK SC', 'NotoSansCJKSC-Regular', KNOWN_BYTES, { throws: true }),
    ]);
    try {
        const resolution = await resolveLocalFonts();
        assert.strictEqual(resolution.fonts.length, 1);

        const host = new FakeHost();
        const compiler = makeCompiler(host);
        const mounted = await mountRuntimeFonts(resolution, compiler);
        assert.strictEqual(mounted.mountedCount, 0);
        assert.strictEqual(mounted.diagnostics.length, 1);
        assert.strictEqual(mounted.diagnostics[0].severity, 'warning');
        assert.strictEqual(mounted.diagnostics[0].code, 'TYPST_LOCAL_FONT_READ_FAILED');
        assert.strictEqual(mounted.effectiveFonts.localFontsAvailable, false);
        assert.deepStrictEqual(mounted.effectiveFonts.fallbackChain, [BUNDLED_MATH_FALLBACK, BUNDLED_TEXT_FALLBACK, SYSTEM_FALLBACK]);

        const domain = makeDomain();
        const promise = compiler.compile(makePayload(domain), makeContext(domain));
        await driveInitHandshake(host);
        await driveCompileRoundTrip(host);
        const result = await promise;
        assert.strictEqual(String.fromCharCode(...result.pdfBytes.slice(0, 5)), '%PDF-');
        compiler.dispose();
    } finally {
        restore();
    }
});

test('mountRuntimeFonts is a no-op for compilers without the runtime-font capability', async () => {
    let blobCalls = 0;
    const restore = mockQueryLocalFonts([
        fakeEntry('Noto Sans CJK SC', 'NotoSansCJKSC-Regular', KNOWN_BYTES, {
            onBlob: () => {
                blobCalls += 1;
            },
        }),
    ]);
    try {
        const resolution = await resolveLocalFonts();
        const stubCompiler = { name: 'stub', compile: async () => ({ pdfBytes: new Uint8Array(), diagnostics: [] }) };
        const mounted = await mountRuntimeFonts(resolution, stubCompiler as any);
        assert.strictEqual(mounted.mountedCount, 0);
        assert.strictEqual(blobCalls, 0, 'bytes must not be read when the compiler cannot consume them');
        assert.notStrictEqual(mounted.effectiveFonts, resolution);
        assert.strictEqual(
            mounted.effectiveFonts.localFontsAvailable,
            false,
            'fonts resolved but not mounted must not report localFontsAvailable=true',
        );
        assert.deepStrictEqual(mounted.effectiveFonts.diagnostics, resolution.diagnostics);
    } finally {
        restore();
    }
});

test('D: production-style CJK path resolves provider bytes into the sandbox and extracts CJK', async (t: { skip: (msg?: string) => void }) => {
    const cjkFont = resolveLocalCjkFont();
    if (!cjkFont) {
        t.skip('no locally installed CJK font on this machine');
        return;
    }
    const cjkBytes = new Uint8Array(fs.readFileSync(cjkFont));
    const restore = mockQueryLocalFonts([fakeEntry('Noto Sans CJK SC', 'NotoSansCJKSC-Regular', cjkBytes)]);
    try {
        const resolution = await resolveLocalFonts();
        assert.strictEqual(resolution.fonts.length, 1);

        const host = new RealWasmSandboxHost(repoRoot());
        const compiler = new TypstSandboxCompiler({ host: host as any });
        const mounted = await mountRuntimeFonts(resolution, compiler);
        assert.strictEqual(mounted.mountedCount, 1);

        const sentences = [
            '天地玄黄，宇宙洪荒。日月盈昃，辰宿列张。',
            '人工智能正在改变软件开发的方式，代码生成只是起点。',
            '春眠不觉晓，处处闻啼鸟。夜来风雨声，花落知多少。',
        ];
        const para = (text: string) => ({
            type: 'paragraph',
            children: [{ type: 'text', text }],
        });
        const messages = sentences.map((s, i) => ({
            id: `m${i}`,
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: [para(`第${i + 1}段：${s}`)],
        }));
        const domain = { index: { key: fixtureKey(String('local-font-cjk'), 'gemini'),   titleSource: "derived",   title: '本地字体 CJK 路径测试', createdAt: '2026-09-26T00:00:00Z', updatedAt: '2026-09-26T00:10:00Z' }, detail: { key: fixtureKey(String('local-font-cjk'), 'gemini'), quality: { status: 'unknown' }, assets: [], messages } };
        const context = {

            assets: { resolve: async () => null },
            locale: 'zh' as const,
            signal: new AbortController().signal,
            reportProgress: () => undefined,
        };
        const result = await compiler.compile(
            makePayload(domain),
            context,
        );
        compiler.dispose();

        const errors = result.diagnostics.filter((d: any) => d.severity === 'error');
        assert.deepStrictEqual(errors, [], `compile errors: ${JSON.stringify(errors)}`);
        const extracted = extractPdfText(result.pdfBytes);
        assert.ok(!extracted.text.includes('�'), 'zero tofu (U+FFFD) in extracted text');
        const cjkRe = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g;
        const inputChars = new Set<string>();
        for (const s of sentences) {
            for (const m of s.matchAll(cjkRe)) inputChars.add(m[0]);
        }
        const missing = [...inputChars].filter((ch) => !extracted.text.includes(ch));
        assert.ok(missing.length === 0, `all input CJK chars extractable; missing: ${missing.slice(0, 20).join('')}`);
    } finally {
        restore();
    }
});


test('E: eight-font budget delivers Mono bytes to the sandbox alongside CJK fonts', async () => {
    const monoBytes = Uint8Array.of(101, 102, 103, 104, 105, 106, 107, 108);
    const entries = [
        ['Noto Sans CJK SC', 'NotoSansCJKsc-Regular'],
        ['Noto Sans CJK', 'NotoSansCJK-Regular'],
        ['PingFang SC', 'PingFangSC-Regular'],
        ['PingFang TC', 'PingFangTC-Regular'],
        ['PingFang HK', 'PingFangHK-Regular'],
        ['Microsoft YaHei', 'MicrosoftYaHei-Regular'],
        ['Microsoft JhengHei', 'MicrosoftJhengHei-Regular'],
        ['Source Han Sans SC', 'SourceHanSansSC-Regular'],
    ];
    const restore = mockQueryLocalFonts([
        ...entries.map(([family, ps]) => fakeEntry(family, ps, KNOWN_BYTES)),
        fakeEntry('DejaVu Sans Mono', 'DejaVuSansMono', monoBytes),
    ]);
    try {
        const resolution = await resolveLocalFonts();
        assert.strictEqual(resolution.fonts.length, 8);
        assert.strictEqual(resolution.fonts[7].family, 'DejaVu Sans Mono');
        const host = new FakeHost();
        const compiler = makeCompiler(host);
        try {
            const mounted = await mountRuntimeFonts(resolution, compiler);
            assert.strictEqual(mounted.mountedCount, 8);
            const domain = makeDomain();
            const pending = compiler.compile(makePayload(domain), makeContext(domain));
            await driveInitHandshake(host);
            const compileMsg = await driveCompileRoundTrip(host);
            const received = (compileMsg.message.fonts as ArrayBuffer[]).map((buffer) => Buffer.from(buffer));
            assert.ok(received.some((font) => font.equals(Buffer.from(monoBytes))),
                'the real Mono file must reach the Typst sandbox despite eight prose candidates');
            await pending;
        } finally {
            compiler.dispose();
        }
    } finally {
        restore();
    }
});

test('F: real Typst WASM embeds the mounted Mono font in a PDF containing code', async (t: { skip: (msg?: string) => void }) => {
    // CI normally provides this system font. Do not add font binaries to the extension.
    const monoPath = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';
    if (!fs.existsSync(monoPath)) {
        t.skip('system DejaVuSansMono.ttf is unavailable');
        return;
    }
    const fontBytes = new Uint8Array(fs.readFileSync(monoPath));
    const restore = mockQueryLocalFonts([fakeEntry('DejaVu Sans Mono', 'DejaVuSansMono', fontBytes)]);
    try {
        const resolution = await resolveLocalFonts();
        assert.deepStrictEqual(resolution.fonts.map((font: any) => font.family), ['DejaVu Sans Mono']);

        const host = new RealWasmSandboxHost(repoRoot());
        const compiler = new TypstSandboxCompiler({ host: host as any });
        try {
            const mounted = await mountRuntimeFonts(resolution, compiler);
            assert.strictEqual(mounted.mountedCount, 1);
            const domain: any = makeDomain();
            domain.detail.messages[1].content = [{
                type: 'code',
                language: 'text',
                code: 'iiiiiiiiii|FIRSTCOL\nWWWWWWWWWW|SECONDCOL',
            }];
            const result = await compiler.compile(makePayload(domain), makeContext(domain));
            assert.deepStrictEqual(result.diagnostics.filter((d: any) => d.severity === 'error'), []);
            const report = probePdfLayout(result.pdfBytes);
            assert.ok(report.fonts.some((name: string) => name.includes('DejaVuSansMono')),
                'the code font must actually be embedded; PDF fonts: ' + report.fonts.join(', '));
            const extracted = extractPdfText(result.pdfBytes).text;
            assert.ok(extracted.includes('FIRSTCOL') && extracted.includes('SECONDCOL'),
                'both code lines should remain selectable text in the PDF');
        } finally {
            compiler.dispose();
        }
    } finally {
        restore();
    }
});

test('Runtime font reads overlap with a small pool and retain fallback order on failure', async () => {
    let active = 0;
    let maximum = 0;
    const mounted: Uint8Array[][] = [];
    const fonts = Array.from({ length: 5 }, (_, index) => ({
        family: 'Local ' + index,
        postscriptName: 'Local' + index,
        style: 'Regular',
        source: 'local' as const,
        getBytes: async () => {
            active++;
            maximum = Math.max(maximum, active);
            try {
                await new Promise<void>(resolve => setImmediate(resolve));
                if (index === 2) throw new Error('font unavailable');
                return Uint8Array.of(index + 1);
            } finally { active--; }
        },
    }));
    const result = await mountRuntimeFonts(
        { fonts, diagnostics: [], fallbackChain: [], localFontsAvailable: true },
        { setRuntimeFonts: (bytes: Uint8Array[]) => { mounted.push(bytes); } },
    );
    assert.strictEqual(maximum, 3, 'font bytes must be read concurrently but with bounded memory');
    assert.strictEqual(active, 0);
    assert.deepStrictEqual(mounted[0].map(bytes => bytes[0]), [1, 2, 4, 5]);
    assert.deepStrictEqual(result.mountedNames.map((name: string) => name.split(' (')[0]),
        ['Local 0', 'Local 1', 'Local 3', 'Local 4']);
    assert.strictEqual(result.diagnostics.length, 1);
    assert.match(result.diagnostics[0].message, /font unavailable/);
});
