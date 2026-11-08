import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { transformSync } from 'esbuild';

const root = resolve(__dirname, '../..');
const core = resolve(root, 'src');
interface Edge { target: string; runtime: boolean }
function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const path = resolve(dir, entry.name);
        return entry.isDirectory() ? files(path) : /\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name) ? [path] : [];
    });
}
const sources = new Map(files(core).map(file => [relative(core, file).replace(/\\/g, '/'), file]));

/** Ignore comments, strings and regex bodies while retaining literal module specifiers. */
interface Token { value: string; literal?: boolean }
function tokens(source: string): Token[] {
    const result: Token[] = [];
    let index = 0;
    while (index < source.length) {
        const rest = source.slice(index);
        if (/^\s/.test(rest)) { index++; continue; }
        if (rest.startsWith('//')) { const end = source.indexOf('\n', index); index = end < 0 ? source.length : end; continue; }
        if (rest.startsWith('/*')) { const end = source.indexOf('*/', index + 2); index = end < 0 ? source.length : end + 2; continue; }
        const quote = source[index];
        if (quote === "'" || quote === '"' || quote === '`') {
            let value = '', escaped = false;
            index++;
            while (index < source.length) {
                const char = source[index++];
                if (escaped) { value += char; escaped = false; }
                else if (char === '\\') escaped = true;
                else if (char === quote) break;
                else value += char;
            }
            result.push({ value, literal: quote !== '`' || !value.includes('${') });
            continue;
        }
        const previous = result.at(-1)?.value;
        if (quote === '/' && (!previous || /^(?:[=(,:!?;{\[]|return|case|=>)$/.test(previous))) {
            index++;
            let bracket = false;
            while (index < source.length) {
                const char = source[index++];
                if (char === '\\') index++;
                else if (char === '[') bracket = true;
                else if (char === ']') bracket = false;
                else if (char === '/' && !bracket) break;
            }
            while (/[a-z]/i.test(source[index] ?? '') && index < source.length) index++;
            result.push({ value: '<regex>' });
            continue;
        }
        const word = /^[$\w]+/.exec(rest);
        const value = word?.[0] ?? quote;
        result.push({ value }); index += value.length;
    }
    return result;
}
function specifiers(source: string): string[] {
    const stream = tokens(source), result: string[] = [];
    stream.forEach((token, index) => {
        if (token.literal) return;
        const next = stream[index + 1], arg = stream[index + 2];
        if ((token.value === 'from' || token.value === 'import') && next?.literal) result.push(next.value);
        else if ((token.value === 'import' || token.value === 'require') && next?.value === '(' && arg?.literal) result.push(arg.value);
    });
    return result;
}
/** esbuild determines runtime edges; source tokens retain erased type-only dependencies. */
function dependencies(file: string, text = readFileSync(file, 'utf8')): Edge[] {
    const output = transformSync(text, { loader: file.endsWith('.tsx') ? 'tsx' : file.endsWith('.ts') ? 'ts' : 'js', format: 'esm', legalComments: 'none' }).code;
    const runtime = new Set(specifiers(output));
    return specifiers(text).filter(specifier => specifier.startsWith('.')).map(specifier => {
        let target = resolve(dirname(file), specifier).replace(/\.js$/, '.ts');
        if (!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(target)) target += '.ts';
        if (!existsSync(target) && target.endsWith('.ts') && existsSync(target + 'x')) target += 'x';
        return { target: relative(core, target).replace(/\\/g, '/'), runtime: runtime.has(specifier) };
    });
}
const graph = new Map([...sources].map(([name, file]) => [name, dependencies(file)]));

test('the compatibility directory is retired and no production source imports it', () => {
    assert.equal(existsSync(resolve(core, 'core/compatibility')), false);
    for (const file of files(resolve(root, 'src'))) {
        for (const edge of dependencies(file)) {
            assert.ok(!edge.target.startsWith('core/compatibility/'), `${relative(root, file)} imports retired ${edge.target}`);
        }
    }
});
test('v1 migration stays isolated to worker readiness and remains covered by the independent upgrade suite', () => {
    assert.ok(existsSync(resolve(core, 'migration/upgradeV1.ts')));
    assert.ok(existsSync(resolve(root, 'tests/upgrade_v1.test.cjs')));
    const wrapper = readFileSync(resolve(root, 'tests/upgrade_released_v17.test.ts'), 'utf8');
    assert.ok(wrapper.includes("require('./upgrade_v1.test.cjs')"));
    const runtimeCallers = [...graph].filter(([, edges]) => edges.some(edge => edge.target === 'migration/upgradeV1.ts'))
        .map(([owner]) => owner).sort();
    assert.deepEqual(runtimeCallers, ['runtime/background/readiness.ts']);
});

function renderer(owner: string): boolean {
    return /^l4\/format\/(?:html|json|markdown|shared|typst)\//.test(owner);
}
function forbidden(owner: string, target: string): boolean {
    if (owner === 'shared/diagnostics/diagnostic.ts') return target !== 'shared/utils/jsonTypes.ts';
    if (owner.startsWith('l2/')) {
        const admission = new Set(['l2/accountAdmission.ts', 'l2/ingestion.ts', 'l2/coverageAdmission.ts', 'l2/readConversation.ts']);
        if (admission.has(owner)) return !/^(l2\/|l3a\/)/.test(target);
        return !target.startsWith('l2/') && target !== 'shared/utils/jsonTypes.ts';
    }
    if (owner.startsWith('l3b/ast/')) return !target.startsWith('l3b/ast/') && target !== 'l2/conversationDetail.ts';
    if (owner.startsWith('l3b/compose/')) return !/^(l2\/|l3b\/|shared\/(?:diagnostics|utils)\/)/.test(target);
    if (renderer(owner)) {
        // Packaging owns the type-only binding; JSON intentionally reads trusted Domain.
        if (target === 'l4/packaging/resourceBindings.ts') return false;
        if (owner === 'l4/format/json/serializeDomainJson.ts' && /^l2\//.test(target)) {
            return /(?:Admission|ingestion|indexCoverage|pageObservation)/.test(target);
        }
        return /^(l1\/(?:parsers|imports|client)\/|l2\/|runtime\/api\/|application\/exportEngine\.ts$|l4\/(?:packaging|delivery)\/|l4\/format\/(?:pdf|resources)\/|l3a\/)/.test(target);
    }
    if (owner.startsWith('l1/parsers/')) {
        if (target.startsWith('l1/parsers/legacyStorage/') && !owner.startsWith('l1/parsers/legacyStorage/')
            && owner !== 'l1/parsers/parseConversation.ts' && owner !== 'l1/parsers/index.ts') return true;
        return /^(l1\/(?:imports|client)\/|l3b\/|l4\/|runtime\/api\/|application\/exportEngine\.ts$|l3a\/)/.test(target);
    }
    return false;
}

test('semantic layers own their files and obey dependency direction, including type-only references', () => {
    for (const [owner, edges] of graph) for (const edge of edges) {
        assert.ok(!forbidden(owner, edge.target), `${owner} must not depend on ${edge.target}`);
        if (owner.startsWith('l3b/ast/') && edge.target === 'l2/conversationDetail.ts') assert.equal(edge.runtime, false, 'AST reuses L2 role/asset types without a runtime dependency');
        if (renderer(owner) && edge.target === 'l4/packaging/resourceBindings.ts') assert.equal(edge.runtime, false, `${owner} must import bindings as a type`);
    }
    for (const old of ['core/api/parser/', 'core/content/', 'core/export/document/', 'core/engine/takeout/', 'core/engine/template/', 'core/provider/record/']) {
        assert.ok(![...sources.keys()].some(name => name.startsWith(old)), `obsolete directory still owns code: ${old}`);
    }
});

test('native parsers, L2 and renderers cannot acquire forbidden dependencies through a shared runtime helper', () => {
    for (const owner of graph.keys()) {
        if (!renderer(owner) && !/^l1\/parsers\//.test(owner) && !owner.startsWith('l2/')) continue;
        function walk(current: string, chain: string[], seen: Set<string>): void {
            if (seen.has(current)) return;
            seen.add(current);
            for (const edge of graph.get(current) ?? []) {
                if (!edge.runtime) continue;
                assert.ok(owner.startsWith('l2/') ? !edge.target.startsWith('l1/') : !forbidden(owner, edge.target), [...chain, edge.target].join(' → '));
                walk(edge.target, [...chain, edge.target], seen);
            }
        }
        walk(owner, [owner], new Set());
    }
});

test('boundary reader detects re-export, type-only, dynamic import and require escape routes', () => {
    const owner = resolve(core, 'l4/format/html/probe.ts');
    const edges = dependencies(owner, `
        import type { DomainMessage } from '../../../l2/conversationDetail.js';
        export { parseGeminiRpcConversation } from '../../../l1/parsers/gemini/rpc/parseConversation.js';
        const decoder = import('../../../l1/parsers/gemini/rpc/detailDecoder.js');
        const storage = require('../../../l3a/storageService.js');
        type Record = import('../../../l1/parsers/legacyStorage/conversationRecord.js').ConversationRecordInput;
    `);
    assert.equal(edges.length, 5);
    assert.deepEqual(edges.map(edge => edge.runtime), [false, true, true, true, false]);
    assert.ok(edges.every(edge => forbidden('l4/format/html/probe.ts', edge.target)));
});

test('native parsing does not allocate export paths or sanitized filenames', () => {
    const naming = new Set(['sanitizeFileName', 'sanitizeRelativePath', 'getUniqueLocalName', 'buildExportFileName']);
    for (const [name, file] of sources) {
        if (!name.startsWith('l1/parsers/')) continue;
        for (const token of tokens(readFileSync(file, 'utf8'))) {
            assert.ok(token.literal || !naming.has(token.value), `${name} uses export naming: ${token.value}`);
        }
    }
});

test('list acquisition consumes parser facts instead of reinterpreting wire fields', () => {
    const retiredReads = new Map([
        ['l1/client/chatgpt/chatgptProvider.ts', new Set(['create_time', 'update_time', 'toProviderItem'])],
        ['l1/client/gemini/listObservation.ts', new Set(['_raw', 'GEMINI_JSPB_SCHEMA', 'payloadToMs'])],
        ['l1/client/gemini/api/pagination.ts', new Set(['_raw', 'GEMINI_JSPB_SCHEMA', 'payloadToMs'])],
    ]);
    for (const [owner, forbiddenReads] of retiredReads) {
        for (const token of tokens(readFileSync(resolve(core, owner), 'utf8'))) {
            assert.ok(token.literal || !forbiddenReads.has(token.value), `${owner} interprets list source field ${token.value}`);
        }
    }
});

test('normal runtime cannot parse historical records or depend on application projections', () => {
    const obsolete = new Set(['parseLegacyConversation', 'toDomainConversationDetail', 'createParsedConversationView', 'readParsedConversation', 'createNativeDetailView', 'ParsedConversationView',
        'parseGeminiTakeoutZip', 'GeminiParserAttachments', 'inferLegacyProviderId', 'getTakeoutMediaForChat', 'extractC2PATimestamp', 'moduleOverrides']);
    for (const file of files(resolve(root, 'src'))) {
        const name = relative(core, file).replace(/\\/g, '/');
        const migration = name.startsWith('l1/parsers/legacyStorage/');
        const text = readFileSync(file, 'utf8');
        for (const edge of dependencies(file, text)) {
            if (/^l1\/parsers\/legacyStorage\/(?:parseRecord|conversationRecord|attachments|contentAdapter|generationIdentity|generatedMediaReconciliation)\.ts$/.test(edge.target)) {
                assert.ok(migration, `${name} depends on the historical record boundary`);
            }
            if (edge.target === 'l1/parsers/legacyStorage/parseIndex.ts') {
                assert.ok(migration || name === 'l3a/storageService.ts' || name === 'diagnostics/diagnosticSnapshot.ts',
                    `${name} interprets historical indexes outside migration/recovery`);
            }
        }
        for (const token of tokens(text)) {
            assert.ok(token.literal || !obsolete.has(token.value), `${name} uses ${token.value}`);
            assert.ok(token.value !== 'conversation-record', `${name} exposes retired runtime input`);
            if (!token.literal && token.value === 'parseConversationRecord') assert.ok(migration, `${name} invokes historical record parsing`);
        }
    }
});


test('only L2 admission and the passive Storage implementation expose Detail writes', () => {
    const owners = new Set(['l2/ingestion.ts', 'l3a/conversationStore.ts', 'l3a/storageService.ts', 'runtime/background/domainStorageHandler.ts']);
    for (const file of files(resolve(root, 'src'))) {
        const owner = relative(resolve(root, 'src'), file).replace(/\\/g, '/');
        const text = readFileSync(file, 'utf8');
        if (!owners.has(owner)) assert.ok(!tokens(text).some(token => !token.literal && token.value === 'putDetail'), `${owner} bypasses Detail admission`);
        assert.ok(!tokens(text).some(token => !token.literal && ['ingestConversation', 'saveDomainConversation', 'selectSnapshot'].includes(token.value)), `${owner} retains an obsolete entry`);
    }
    const ingestion = readFileSync(resolve(core, 'l2/ingestion.ts'), 'utf8');
    assert.doesNotMatch(ingestion, /parsingResult|StorageRecord|revision|acquisitionHints|resourceChanged|forceWrite|touched/);
});

test('passive Storage cannot own Domain selection or scan lifecycle rules', () => {
    const rules = new Set(['mergeConversationIndex', 'selectConversationDetail', 'selectSnapshot', 'findAccount',
        'advanceIndexCoverage', 'indexCoverageConnects', 'indexCoverageExhausted', 'assertCoverageCompletion']);
    for (const [name, file] of sources) if (name.startsWith('l3a/')) {
        for (const token of tokens(readFileSync(file, 'utf8'))) {
            assert.ok(token.literal || !rules.has(token.value), `${name} decides Domain rule ${token.value}`);
        }
    }
    for (const retired of ['l3a/conversationIngest.ts', 'l3a/conversationIndexFromParsed.ts',
        'l3a/conversationDetailStore.ts', 'l1/parsers/legacyStorage/parseConversation.ts']) {
        assert.equal(sources.has(retired), false, `${retired} leaves an alternate v1 path`);
    }
});

// A .js specifier can resolve to TSX under the production bundler.
test('boundary reader includes TSX components and resolves their runtime imports', () => {
    assert.ok(sources.has('ui/options/views/conversationList.tsx'));
    const view = resolve(core, 'ui/options/views/listView.ts');
    assert.ok(dependencies(view).some(edge => edge.runtime && edge.target === 'ui/options/views/conversationList.tsx'));
});

test('UI export session owns observations while state models and React views stay separate', () => {
    const session = 'ui/options/controllers/exportSession.ts';
    const file = sources.get(session);
    assert.ok(file);
    const imports = specifiers(readFileSync(file, 'utf8'));
    assert.ok(imports.every(specifier => specifier !== 'react' && !specifier.startsWith('react-dom')));
    for (const edge of graph.get(session) ?? []) if (edge.runtime) {
        assert.ok(edge.target.startsWith('ui/') && !edge.target.startsWith('ui/options/views/'),
            `${session} bypasses its UI observation boundary through ${edge.target}`);
    }
    for (const owner of ['ui/options/state/exportIssues.ts', 'ui/options/state/foregroundTask.ts']) {
        assert.ok(sources.has(owner));
        assert.ok((graph.get(owner) ?? []).every(edge => !edge.runtime), `${owner} must remain a data model`);
    }
});
