/**
 * tests/canonical-schema-conformance.test.ts
 *
 * Real conformance tests against the versioned canonical JSON Schema.
 *
 * The repo has no JSON-Schema validator dependency (and this PR may not add
 * one), so this file implements a small recursive evaluator that READS AND
 * EXECUTES the actual schema resource
 * (src/core/export/canonical/resources/canonical-conversation-v1.schema.json)
 * instead of hand-writing field assertions. It supports every validation
 * keyword the schema uses: $ref, oneOf, type, required, properties,
 * additionalProperties, items, enum, const, minimum, maximum,
 * exclusiveMinimum.
 *
 * Every conformance test below runs the SAME bundle through both
 * validateBundle() (the TS contract) and the schema evaluator (the JSON
 * contract) so the two can never drift apart silently again.
 */
export {};
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const canonical = require('../src/core/export/canonical/index.js');
const { normalizeGeminiConversation, validateBundle } = canonical;

const schemaPath = path.join(
    __dirname, '..', 'src', 'core', 'export', 'canonical',
    'resources', 'canonical-conversation-v1.schema.json',
);
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const fixtureDir = path.join(__dirname, 'fixtures', 'canonical');

// ---------------------------------------------------------------- evaluator

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
        default: throw new Error(`schema evaluator: unsupported type '${t}'`);
    }
}

function resolveRef(ref: string, root: Schema): Schema {
    if (ref === '#') return root;
    const m = /^#\/\$defs\/([^/]+)$/.exec(ref);
    if (!m) throw new Error(`schema evaluator: unsupported $ref '${ref}'`);
    const def = root.$defs?.[m[1]];
    if (!def) throw new Error(`schema evaluator: unknown $defs entry '${ref}'`);
    return def;
}

function valueId(value: unknown, ctx: { ids: WeakMap<object, number>; nextId: number }): string {
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

/** Validate value against schema; returns a list of errors (empty = valid). */
function evaluate(
    s: Schema,
    value: unknown,
    root: Schema,
    path: string,
    ctx: { seen: Set<string>; ids: WeakMap<object, number>; nextId: number },
): string[] {
    if (s.$ref !== undefined) {
        const ref = s.$ref as string;
        // Circularity is (ref, value) based: re-entering the same ref for a
        // strictly smaller subvalue (e.g. InlineNode -> children -> InlineNode)
        // always terminates on finite values and is NOT a cycle.
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
            return errors; // further descent is meaningless on a type mismatch
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
                errors.push(...evaluate(props[k], v, root, `${path}/${k}`, ctx));
            } else if (s.additionalProperties === false) {
                errors.push(`${path}: additional property '${k}' not allowed`);
            } else if (typeof s.additionalProperties === 'object' && s.additionalProperties !== null) {
                errors.push(...evaluate(s.additionalProperties as Schema, v, root, `${path}/${k}`, ctx));
            } else if (s.additionalProperties !== undefined && s.additionalProperties !== true) {
                throw new Error(`schema evaluator: unsupported additionalProperties form at ${path}`);
            }
        }
    }
    if (Array.isArray(value) && s.items !== undefined) {
        value.forEach((item, idx) => {
            errors.push(...evaluate(s.items as Schema, item, root, `${path}/${idx}`, ctx));
        });
    }
    return errors;
}

function newCtx(): { seen: Set<string>; ids: WeakMap<object, number>; nextId: number } {
    return { seen: new Set(), ids: new WeakMap(), nextId: 0 };
}

function schemaErrors(bundle: unknown): string[] {
    return evaluate(schema, bundle, schema, '#', newCtx());
}

function bundleErrors(bundle: unknown): string[] {
    return validateBundle(bundle)
        .filter((d: any) => d.severity === 'error')
        .map((d: any) => `${d.code}: ${d.message}`);
}

/** Assert a bundle satisfies BOTH contracts; fail loudly with the first errors. */
function assertBothContracts(bundle: unknown, label: string): void {
    const tsErrors = bundleErrors(bundle);
    assert.deepStrictEqual(tsErrors, [], `validateBundle errors for ${label}:\n${tsErrors.join('\n')}`);
    const jsErrors = schemaErrors(bundle);
    assert.deepStrictEqual(jsErrors, [], `JSON Schema errors for ${label}:\n${jsErrors.slice(0, 10).join('\n')}`);
}

// ---------------------------------------------------------------- tests

test('every canonical fixture satisfies both validateBundle and the JSON Schema', async () => {
    const files = fs.readdirSync(fixtureDir).filter((f: string) => f.endsWith('.json'));
    assert.ok(files.length > 0, 'fixtures exist');
    for (const f of files) {
        const raw = JSON.parse(fs.readFileSync(path.join(fixtureDir, f), 'utf8'));
        // Fixtures are either canonical bundles already, or raw Gemini inputs
        // (gemini-normalizer-*) that must be normalized first.
        const bundle = raw && typeof raw === 'object' && 'conversation' in raw && 'schemaVersion' in raw
            ? raw
            : (await normalizeGeminiConversation(raw)).bundle;
        assertBothContracts(bundle, f);
    }
});

test('GeminiNormalizer output satisfies both contracts (incl. first-class inline images)', async () => {
    const sample = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'gemini-normalizer-sample.json'), 'utf8'));
    const { bundle } = await normalizeGeminiConversation(sample);
    assertBothContracts(bundle, 'gemini-normalizer-sample output');
    // The output really exercises the new ImageInline schema branch.
    const user = (bundle as any).conversation.messages.find((m: any) => m.id === 'm-u1');
    const img = user.blocks[6].children.find((c: any) => c.type === 'image');
    assert.ok(img, 'output contains an ImageInline node');
});

test('string title and URL satisfy both contracts', async () => {
    const sample = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'gemini-normalizer-sample.json'), 'utf8'));
    const { bundle } = await normalizeGeminiConversation(sample);
    assert.strictEqual(bundle.conversation.title, 'RPC Authoritative Title');
    assert.strictEqual(bundle.conversation.url, sample.url);
    assertBothContracts(bundle, 'string title and URL');
});

test('object title is rejected by both contracts', async () => {
    const sample = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'gemini-normalizer-sample.json'), 'utf8'));
    const { bundle } = await normalizeGeminiConversation(sample);
    (bundle as any).conversation.title = { value: 'Retired title object', source: 'rpc' };
    assert.ok(schemaErrors(bundle).length > 0);
    assert.ok(validateBundle(bundle).some((d: any) => d.code === 'TITLE_INVALID'));
});

test('thought block with initiallyCollapsed is rejected by the JSON Schema', async () => {
    const sample = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'gemini-normalizer-sample.json'), 'utf8'));
    const { bundle } = await normalizeGeminiConversation(sample);
    const model = (bundle as any).conversation.messages.find((m: any) => m.id === 'm-a1');
    const thought = model.blocks.find((b: any) => b.type === 'thought');
    assert.ok(thought, 'fixture has a thought block to poison');
    thought.initiallyCollapsed = true;
    const errors = schemaErrors(bundle);
    assert.ok(
        errors.some((e) => e.includes('initiallyCollapsed') && e.includes('not allowed')),
        `schema must reject renderer-only initiallyCollapsed, got:\n${errors.slice(0, 5).join('\n')}`,
    );
    // The TS contract flags it too (BANNED_RENDERER_KEYS -> RENDERER_KEY_LEAK warning).
    const allIssues = validateBundle(bundle);
    assert.ok(
        allIssues.some((d: any) => d.code === 'RENDERER_KEY_LEAK'),
        'validateBundle also flags initiallyCollapsed',
    );
});
