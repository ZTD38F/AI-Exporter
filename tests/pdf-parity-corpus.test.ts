/**
 * tests/pdf-parity-corpus.test.ts
 *
 * Tier 1 harness for the HTML/PDF parity corpus (Phase F, §17).
 *
 * Gate 1 (active): every fixture passes the canonical runtime validator.
 * Gate 2 (active): every fixture conforms to the versioned canonical JSON
 *   Schema (src/core/export/canonical/resources/canonical-conversation-v1.schema.json),
 *   evaluated by a small reader that EXECUTES the actual schema resource --
 *   no hand-written field assertions, no new validator dependency.
 * Gate 3 (active since D8-A): HTML-vs-PDF text parity per fixture.
 *
 * Gate 3 compares the two render paths in-process:
 *   HTML side: renderCanonicalHtml(bundle) -> visible text lines.
 *   PDF side:  toTypstPayload(bundle, ...) -> walk the TypstBlockNode tree,
 *     extracting the text the Typst templates will typeset (code language
 *     labels, table captions, file names, missing-asset fallbacks, ...).
 * The real WASM compile + PDF-byte text extraction stays a Tier 2 /
 * real-browser concern (no WASM compiler or PDF text extractor exists in the
 * Tier 1 Node environment); this gate asserts content parity at the render
 * level both paths share: no content may be dropped, invented, or reworded
 * between the HTML renderer and the Typst payload the PDF is typeset from.
 *
 * Comparison rules (documented, not weakened):
 * - Both sides are reduced to normalized content lines (tags stripped, HTML
 *   entities decoded, whitespace collapsed, spaces between CJK characters
 *   removed -- the renderers disagree on insignificant spacing around inline
 *   markup, never on words).
 * - Lines are compared as order-preserving subsequences in BOTH directions:
 *   every HTML line must appear in the PDF lines in order (no drops) and
 *   every PDF line must appear in the HTML lines in order (no phantoms).
 * - The streams are partitioned into `body` and `asset` lines. The HTML
 *   renderer hoists image/file blocks into an attachment carousel placed
 *   before the body for user turns and after it for model turns, while the
 *   PDF keeps asset blocks inline -- a deliberate, visible presentation
 *   difference. Partitioning asserts the same body text in the same order
 *   and the same asset cards in the same relative order on both sides.
 * - Documented renderer chrome is stripped, never content: the code-block
 *   "复制" copy button, the thought <summary> header ("思考过程" -- the
 *   thought content itself is compared), and the missing-asset placeholder
 *   framing ("附件缺失 · X MISSING" / "图片缺失 · X" keep the human-readable
 *   label X, which is what the PDF fallback shows).
 * - Known degradations are asserted explicitly, not skipped. (The former
 *   math-cjk citation-title degradation was fixed by the unified citation
 *   label rule: explicit label -> title -> publisher -> [n].)
 */
export {};
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const canonical = require('../src/core/export/canonical/index.js');
const { validateBundle } = canonical;
const { renderCanonicalHtml } = require('../src/core/export/canonical/renderCanonicalHtml.js');
const { toTypstPayload } = require('../src/core/export/typst/payload.js');

const corpusDir = path.join(__dirname, 'parity-corpus');
const schemaPath = path.join(
    __dirname, '..', 'src', 'core', 'export', 'canonical',
    'resources', 'canonical-conversation-v1.schema.json',
);
const schema: Record<string, any> = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

const fixtureNames: string[] = fs
    .readdirSync(corpusDir)
    .filter((f: string) => f.endsWith('.json'))
    .sort();

const loadFixture = (name: string): any =>
    JSON.parse(fs.readFileSync(path.join(corpusDir, name), 'utf8'));

// ---------------------------------------------------------------------------
// Small JSON-Schema evaluator (reads and executes the real schema resource).
// Supports every keyword the canonical v1 schema uses: $ref, oneOf, type,
// required, properties, additionalProperties, items, enum, const, minimum,
// maximum, exclusiveMinimum. Same philosophy as
// tests/canonical-schema-conformance.test.ts: the repo carries no JSON-Schema
// validator dependency, and this file must not add one.
// ---------------------------------------------------------------------------

type Schema = Record<string, any>;

function kindOf(v: unknown): string {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
}

function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (kindOf(a) !== kindOf(b)) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((x, i) => deepEqual(x, (b as unknown[])[i]));
    }
    if (a !== null && typeof a === 'object' && b !== null && typeof b === 'object') {
        const ao = a as Record<string, unknown>;
        const bo = b as Record<string, unknown>;
        const ka = Object.keys(ao);
        const kb = Object.keys(bo);
        return ka.length === kb.length && ka.every((k) => k in bo && deepEqual(ao[k], bo[k]));
    }
    return false;
}

function checkType(v: unknown, t: string): boolean {
    switch (t) {
        case 'string': return typeof v === 'string';
        case 'number': return typeof v === 'number';
        case 'integer': return typeof v === 'number' && Number.isInteger(v);
        case 'boolean': return typeof v === 'boolean';
        case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
        case 'array': return Array.isArray(v);
        case 'null': return v === null;
        default: throw new Error(`parity schema evaluator: unsupported type '${t}'`);
    }
}

function resolveRef(ref: string, root: Schema): Schema {
    if (ref === '#') return root;
    const m = /^#\/\$defs\/([^/]+)$/.exec(ref);
    if (!m) throw new Error(`parity schema evaluator: unsupported $ref '${ref}'`);
    const def = root.$defs?.[m[1]];
    if (!def) throw new Error(`parity schema evaluator: unknown $defs entry '${ref}'`);
    return def;
}

interface EvalCtx {
    seen: Set<string>;
    ids: WeakMap<object, number>;
    nextId: number;
}

function valueId(value: unknown, ctx: EvalCtx): string {
    if (value !== null && typeof value === 'object') {
        let id = ctx.ids.get(value);
        if (id === undefined) {
            id = ctx.nextId++;
            ctx.ids.set(value, id);
        }
        return `obj${id}`;
    }
    return `${typeof value}:${String(value)}`;
}

function evaluate(
    s: Schema,
    value: unknown,
    root: Schema,
    path: string,
    ctx: EvalCtx,
): string[] {
    if (s.$ref !== undefined) {
        const ref = s.$ref as string;
        // Circularity is (ref, value-identity) based: re-entering the same ref
        // for a strictly smaller subvalue (e.g. BlockNode -> quote.blocks ->
        // BlockNode) always terminates on finite values and is NOT a cycle.
        const key = `${ref}@${valueId(value, ctx)}`;
        if (ctx.seen.has(key)) return [`${path}: circular $ref ${ref}`];
        ctx.seen.add(key);
        try {
            return evaluate(resolveRef(ref, root), value, root, path, ctx);
        } finally {
            ctx.seen.delete(key);
        }
    }
    const errors: string[] = [];
    if (s.const !== undefined && !deepEqual(value, s.const)) {
        errors.push(`${path}: expected const ${JSON.stringify(s.const)}, got ${JSON.stringify(value)?.slice(0, 80)}`);
    }
    if (s.enum !== undefined && !(s.enum as unknown[]).some((e) => deepEqual(e, value))) {
        errors.push(`${path}: value not in enum ${JSON.stringify(s.enum)}`);
    }
    if (s.type !== undefined) {
        const types = (Array.isArray(s.type) ? s.type : [s.type]) as string[];
        if (!types.some((t) => checkType(value, t))) {
            errors.push(`${path}: expected type ${types.join('|')}, got ${kindOf(value)}`);
            return errors;
        }
    }
    if (s.oneOf !== undefined) {
        const results = (s.oneOf as Schema[]).map((sub) => evaluate(sub, value, root, path, ctx));
        const matches = results.filter((r) => r.length === 0);
        if (matches.length !== 1) {
            errors.push(`${path}: oneOf matched ${matches.length} branches, want exactly 1`);
            results.forEach((r, i) => {
                if (r.length > 0) errors.push(`${path} ~branch${i}: ${r.slice(0, 3).join(' | ')}`);
            });
        }
    }
    if (typeof value === 'number') {
        if (s.minimum !== undefined && value < s.minimum) errors.push(`${path}: ${value} < minimum ${s.minimum}`);
        if (s.maximum !== undefined && value > s.maximum) errors.push(`${path}: ${value} > maximum ${s.maximum}`);
        if (s.exclusiveMinimum !== undefined && value <= s.exclusiveMinimum) {
            errors.push(`${path}: ${value} <= exclusiveMinimum ${s.exclusiveMinimum}`);
        }
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>;
        for (const req of (s.required ?? []) as string[]) {
            if (!(req in obj)) errors.push(`${path}: missing required property '${req}'`);
        }
        const props = (s.properties ?? {}) as Record<string, Schema>;
        for (const [k, v] of Object.entries(obj)) {
            if (k in props) {
                errors.push(...evaluate(props[k], v, root, path ? `${path}.${k}` : k, ctx));
            } else if (s.additionalProperties === false) {
                errors.push(`${path}: additional property '${k}' not allowed`);
            }
        }
    }
    if (Array.isArray(value) && s.items !== undefined) {
        value.forEach((item, i) => {
            errors.push(...evaluate(s.items as Schema, item, root, `${path}[${i}]`, ctx));
        });
    }
    return errors;
}

function schemaErrors(bundle: unknown): string[] {
    const ctx: EvalCtx = { seen: new Set<string>(), ids: new WeakMap(), nextId: 0 };
    return evaluate(schema, bundle, schema, '$', ctx);
}

// ---------------------------------------------------------------------------
// Gate 1 (active): runtime validator
// ---------------------------------------------------------------------------

test('parity corpus: every fixture passes the canonical runtime validator', () => {
    assert.ok(fixtureNames.length >= 4, `expected >= 4 parity fixtures, found ${fixtureNames.length}`);
    for (const name of fixtureNames) {
        const diags = validateBundle(loadFixture(name)) as Array<{ severity: string; code: string; message: string }>;
        const errors = diags.filter((d) => d.severity === 'error');
        assert.deepStrictEqual(errors, [], `${name}: validator errors: ${JSON.stringify(errors)}`);
        const warnings = diags.filter((d) => d.severity === 'warning');
        assert.deepStrictEqual(warnings, [], `${name}: validator warnings (keep fixtures clean): ${JSON.stringify(warnings)}`);
    }
});

test('parity corpus: long-conversation fixture really is a long conversation', () => {
    const bundle = loadFixture('long-conversation-121.json');
    const messages = bundle.conversation.messages as Array<{ id: string }>;
    assert.strictEqual(messages.length, 121, 'long-conversation fixture must carry 121 messages');
    const blockIds = new Set<string>();
    for (const m of messages) {
        for (const b of (m as any).blocks as Array<{ id: string }>) {
            assert.ok(!blockIds.has(b.id), `duplicate block id ${b.id}`);
            blockIds.add(b.id);
        }
    }
});

// ---------------------------------------------------------------------------
// Gate 2 (active): JSON Schema conformance against the real schema resource
// ---------------------------------------------------------------------------

test('parity corpus: every fixture conforms to canonical-conversation-v1.schema.json', () => {
    for (const name of fixtureNames) {
        const errs = schemaErrors(loadFixture(name));
        assert.deepStrictEqual(errs, [], `${name}: schema errors:\n${errs.slice(0, 10).join('\n')}`);
    }
});

// ---------------------------------------------------------------------------
// Gate 3 (active since D8-A): HTML-vs-PDF text parity per fixture.
// ---------------------------------------------------------------------------

const CJK_CLASS = '\\u2e80-\\u9fff\\u3400-\\u4dbf\\uf900-\\ufaff';

function decodeEntities(s: string): string {
    return s
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&#(\d+);/g, (_m: string, n: string) => String.fromCodePoint(parseInt(n, 10)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_m: string, n: string) => String.fromCodePoint(parseInt(n, 16)));
}

/** Collapse whitespace and drop insignificant spaces between CJK characters. */
function normalizeLine(s: string): string {
    let t = s.replace(/\s+/g, ' ').trim();
    t = t.replace(new RegExp(`([${CJK_CLASS}])\\s+(?=[${CJK_CLASS}])`, 'g'), '$1');
    return t;
}

/**
 * Strip documented HTML presentation chrome. Returns null to drop the line.
 * Never touches conversation content: the missing-asset placeholders keep the
 * human-readable label, which is exactly what the PDF fallback shows.
 */
function stripHtmlChrome(line: string): string | null {
    if (line === '复制') return null; // code-block copy button
    if (line === '思考过程') return null; // thought <summary> header; thought content is compared
    const missing = /^附件缺失\s*·\s*(.*?)\s*MISSING$/.exec(line);
    if (missing) return missing[1] || null; // missing attachment card keeps the asset label
    return line.replace(/图片缺失\s*·\s*/g, ''); // missing inline-image placeholder keeps the asset name
}

function textLinesFromHtml(html: string): string[] {
    // This oracle compares message bodies; the document title/metadata are rendered by document.typ.
    let t = html.replace(/<header class="gem-conversation-header">[\s\S]*?<\/header>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<math[\s\S]*?<annotation\b[^>]*>([\s\S]*?)<\/annotation>[\s\S]*?<\/math>/gi, '$1');
    // Block-level closings and <br>/<hr> are line breaks; every other tag is
    // removed WITHOUT inserting a space so inline markup (strong/em/a/code)
    // never introduces phantom spacing around CJK text.
    t = t.replace(/<\/(p|div|section|article|li|ul|ol|h[1-6]|tr|th|td|thead|tbody|table|blockquote|pre|figure|figcaption|details|summary|caption)\b[^>]*>/gi, '\n');
    t = t.replace(/<(br|hr)\b[^>]*>/gi, '\n');
    t = t.replace(/<[^>]+>/g, '');
    t = decodeEntities(t);
    const out: string[] = [];
    for (const raw of t.split('\n')) {
        const n = normalizeLine(raw);
        if (!n) continue;
        const s = stripHtmlChrome(n);
        if (s) out.push(s);
    }
    return out;
}

interface TextParts { body: string[]; asset: string[]; }

/**
 * Partition the HTML into body lines and attachment-card lines. The HTML
 * renderer hoists image/file blocks into an attachment carousel (before the
 * body for user turns, after it for model turns); the PDF keeps asset blocks
 * inline. Comparing the two partitions separately asserts the same body text
 * in the same order and the same asset cards in the same relative order.
 */
function htmlTextParts(html: string): TextParts {
    const assetSegs: string[] = [];
    const assetRe = /<a class="gem-att-card[\s\S]*?<\/a>|<div class="gem-missing-asset">[\s\S]*?<\/div>/g;
    const bodyHtml = html.replace(assetRe, (m: string) => { assetSegs.push(m); return '\n'; });
    return { body: textLinesFromHtml(bodyHtml), asset: textLinesFromHtml(assetSegs.join('\n')) };
}

/** Flatten Typst inline nodes to the text the template typesets. */
function typstInlineText(nodes: any[]): string {
    let s = '';
    for (const n of nodes ?? []) {
        switch (n.type) {
            case 'text': s += n.text; break;
            case 'strong': case 'emphasis': case 'strikethrough': case 'link': s += typstInlineText(n.children); break;
            case 'inlineCode': s += n.text; break;
            case 'lineBreak': s += '\n'; break;
            case 'image': s += n.alt ?? `[image: ${n.asset}]`; break;
            case 'inlineMath': s += n.latex; break;
            default: break;
        }
    }
    return s;
}

function typstTextParts(payload: any, bundle: any): TextParts {
    const canonById = new Map<string, any>(
        ((bundle.conversation.messages ?? []) as any[]).map((m) => [m.id, m]),
    );
    const body: string[] = [];
    const asset: string[] = [];
    const emit = (isAsset: boolean, text: string): void => {
        for (const raw of String(text).split('\n')) {
            const n = normalizeLine(raw);
            if (n) (isAsset ? asset : body).push(n);
        }
    };
    const emitBlock = (b: any, canonType: string | undefined): void => {
        // A missing image/file block reaches the PDF as an `unknown` fallback node;
        // the canonical type keeps it in the asset partition with its HTML carousel card.
        const isAsset = b.type === 'image' || b.type === 'file' || canonType === 'image' || canonType === 'file';
        switch (b.type) {
            case 'paragraph': {
                emit(isAsset, typstInlineText(b.children));
                return;
            }
            case 'thematicBreak':
                return;
            case 'heading':
                emit(isAsset, typstInlineText(b.children));
                return;
            case 'quote':
            case 'note': {
                if (b.blocks) {
                    for (const sub of b.blocks) emitBlock(sub, canonType);
                } else {
                    emit(isAsset, typstInlineText(b.children));
                }
                return;
            }
            case 'list':
                for (const item of b.items ?? []) for (const sub of item.blocks ?? []) emitBlock(sub, canonType);
                return;
            case 'code': {
                const header = b.filename
                    ? (b.language && b.language !== 'text' ? `${b.filename} · ${b.language}` : b.filename)
                    : b.language;
                emit(isAsset, header + (b.meta ? ` · ${b.meta}` : ''));
                emit(isAsset, b.text);
                return;
            }
            case 'math':
                emit(isAsset, b.latex);
                return;
            case 'table':
                if (b.caption) emit(isAsset, b.caption);
                for (const row of b.headers ?? []) for (const cell of row) emit(isAsset, typstInlineText(cell.children));
                for (const row of b.rows ?? []) for (const cell of row) emit(isAsset, typstInlineText(cell.children));
                return;
            case 'image':
                if (b.caption) emit(isAsset, b.caption);
                return;
            case 'file':
                emit(isAsset, b.name);
                return;
            case 'unknown':
                if (b.blocks) {
                    for (const sub of b.blocks) emitBlock(sub, canonType);
                } else if (b.fallback) {
                    emit(isAsset, b.fallback);
                }
                return;
            default:
                return;
        }
    };
    if (payload.title) body.push(normalizeLine(payload.title));
    for (const msg of payload.messages ?? []) {
        const cblocks: any[] = canonById.get(msg.id)?.blocks ?? [];
        // toRenderMessage maps canonical blocks 1:1, optionally prepending one
        // role-prefix note (system/developer/unknown roles only).
        const offset = (msg.blocks?.length ?? 0) - cblocks.length;
        (msg.blocks ?? []).forEach((b: any, j: number) => {
            emitBlock(b, cblocks[j - offset]?.type);
        });
        for (const a of msg.attachments ?? []) {
            if (a.type === 'file') emit(true, a.name);
            else {
                emit(true, a.name);
                if (a.meta) emit(true, a.meta);
            }
        }
    }
    return { body: body.filter(Boolean), asset: asset.filter(Boolean) };
}

/** Order-preserving subsequence: first needle missing from haystack, else null. */
function firstMissing(needles: string[], haystack: string[]): string | null {
    let h = 0;
    for (const n of needles) {
        let found = false;
        while (h < haystack.length) {
            if (haystack[h] === n) { found = true; h++; break; }
            h++;
        }
        if (!found) return n;
    }
    return null;
}

function assertBidirectionalParity(name: string, htmlParts: TextParts, pdfParts: TextParts): void {
    for (const part of ['body', 'asset'] as const) {
        const dropped = firstMissing(htmlParts[part], pdfParts[part]);
        assert.strictEqual(dropped, null,
            `${name}: HTML ${part} line has no PDF counterpart (content dropped by PDF path): ${JSON.stringify(dropped)}`);
        const phantom = firstMissing(pdfParts[part], htmlParts[part]);
        assert.strictEqual(phantom, null,
            `${name}: PDF ${part} line has no HTML counterpart (phantom PDF content): ${JSON.stringify(phantom)}`);
    }
}

interface ParityInputs {
    htmlParts: TextParts;
    pdfParts: TextParts;
    payload: any;
    diagnostics: Array<{ code: string; severity: string }>;
    htmlDiagnostics: Array<{ code: string }>;
}

function parityInputs(name: string): ParityInputs {
    const bundle = loadFixture(name);
    const { html, diagnostics: htmlDiagnostics } = renderCanonicalHtml(bundle) as {
        html: string; diagnostics: Array<{ code: string }>;
    };
    const htmlParts = htmlTextParts(html);
    // assetPath: () => undefined exercises the missing-asset path, matching
    // the fixtures (every fixture asset declares status 'missing').
    const { payload, diagnostics } = toTypstPayload(bundle, { assetPath: () => undefined }) as {
        payload: any; diagnostics: Array<{ code: string; severity: string }>;
    };
    const pdfParts = typstTextParts(payload, bundle);
    return { htmlParts, pdfParts, payload, diagnostics, htmlDiagnostics };
}

for (const name of fixtureNames) {
    // math-cjk carries a known, explicitly asserted citation degradation and
    // is covered by its own test below instead of the generic loop.
    if (name === 'math-cjk.json') continue;
    test(`parity corpus: HTML-vs-PDF text parity for ${name}`, () => {
        const { htmlParts, pdfParts, diagnostics, htmlDiagnostics } = parityInputs(name);
        assertBidirectionalParity(name, htmlParts, pdfParts);
        if (name === 'image-attachment.json') {
            // Every asset in this fixture is status 'missing': both renderers
            // must degrade VISIBLY (placeholder text + diagnostic), never by
            // silently dropping the attachment.
            const codes = diagnostics.map((d) => d.code);
            assert.ok(codes.includes('TYPST_V8_IMAGE_MISSING'), 'PDF path must flag missing block images');
            assert.ok(codes.includes('TYPST_V8_INLINE_IMAGE_MISSING'), 'PDF path must flag missing inline images');
            assert.ok(
                htmlDiagnostics.some((d) => d.code === 'HTML_ASSET_UNRESOLVED'),
                'HTML path must flag unresolvable assets',
            );
        }
    });
}

test('parity corpus: math-cjk citation titles keep fidelity on both sides', () => {
    const name = 'math-cjk.json';
    const { htmlParts, pdfParts } = parityInputs(name);

    const citeTitle = '微积分基本定理';
    assert.ok(htmlParts.body.some((l) => l.includes(citeTitle)), 'HTML shows the citation title');
    assert.ok(
        pdfParts.body.some((l) => l.includes(citeTitle)),
        'PDF shows the citation title (label fidelity, no longer degraded to [n])',
    );

    const htmlPara = htmlParts.body.find((l) => l.includes('牛顿—莱布尼茨公式'));
    const pdfPara = pdfParts.body.find((l) => l.includes('牛顿—莱布尼茨公式'));
    assert.ok(htmlPara !== undefined && pdfPara !== undefined, 'citation paragraph must exist on both sides');
    assert.ok(
        pdfPara?.includes('它把定积分转化为求原函数的过程'),
        'PDF keeps the paragraph text around the citation',
    );

    assertBidirectionalParity(
        name,
        { body: htmlParts.body, asset: htmlParts.asset },
        { body: pdfParts.body, asset: pdfParts.asset },
    );
});
