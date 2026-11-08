import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { API } from 'typescript/unstable/sync';
import { trustBoundaryViolations } from '../helpers/domainTrustBoundary.js';

const root = resolve(__dirname, '../..');
function files(dir: string): string[] { return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(dir, entry.name); return entry.isDirectory() ? files(path) : /\.[cm]?[jt]s$/.test(entry.name) ? [path] : [];
}); }
test('Domain schema, closure, trust assertions and authenticated entrypoints stay at their owners', () => {
    const api = new API({ cwd: root });
    try {
        const snapshot = api.updateSnapshot({ openProjects: [resolve(root, 'tsconfig.json')] });
        const project = snapshot.getProject(resolve(root, 'tsconfig.json'))!;
        const problems = files(resolve(root, 'src')).flatMap(path => trustBoundaryViolations(project.program.getSourceFile(path)!, relative(resolve(root, 'src'), path), project.checker));
        assert.deepEqual(problems, []);
        snapshot.dispose();
    } finally { api.close(); }
});
test('compiler-based gate rejects independent bypasses, including aliases, without matching comments or strings', () => {
    const cases = [
        `import {assertDomainClosure as check} from './closure'; check(raw);`,
        `import * as checks from './closure'; const check=checks.assertDomainClosure;check(raw);`,
        `checks['assertDomainClosure'](raw);`,
        `(checks.assertDomainClosure)(raw);`,
        `const {assertDomainClosure:check}=checks;check(raw);`,
        `import {validateParserDomain as trust} from './validation';trust(raw);`,
        `export {restoreDomainSnapshot as trust} from './validation';`,
        `const result=raw as TrustedDomain;`,
        `const result=raw as string;`,
        `const result=raw!;`,
        `const result=<number>raw;`,
        `import type {TrustedDomain as Closed} from './domain';type Native=Closed;const result=raw as Native;`,
        `function nativeResult(raw:unknown){return (raw as unknown) as ResourceConversationParseResult;}`,
        `function shallow(value:unknown):value is ResourceConversationParseResult{return !!value;}`,
        `const result:TrustedDomain=JSON.parse(text);`,
        `function decode(text:string):TrustedDomain{return (JSON.parse(text));}`,
        `const decode=(text:string):ResourceConversationParseResult=>JSON.parse(text);`,
        `const schema={providerId:v=>true,id:v=>true,title:v=>true,timestamp:v=>true,messages:v=>true,assets:v=>true};`,
        `requestNativeDetail(()=>Promise.resolve(pageEvent.data));`,
        `callDomainBroker('get', raw);`,
        `import {parseGeminiResponse as decode} from './rpc';decode(text);`,
        `import * as rpc from './rpc';const decode=rpc.parseGeminiResponse;decode(text);`,
        `export {parseGeminiCapturedSource as decode} from './capture';`,
        `rpc['parseGeminiRpcConversation'](text, context);`,
        `import * as list from '../l1/parsers/gemini/rpc/parseList.js';`,
        `export * from '../l1/parsers/gemini/rpc/parseList.js';`,
    ];
    const adapterCases = ['function adapt(v:unknown){}', 'function adapt<T>(v:T){}', 'const v=typeof raw;', 'const v=raw as string;', 'const v=raw!;'];
    const virtual = new Map(cases.map((source, index) => [resolve(root, `tests/arch/__domain_probe_${index}.ts`), source]));
    const adapterProbes = adapterCases.map((source, index) => [resolve(root, `tests/arch/__adapter_probe_${index}.ts`), source] as const);
    for (const [path, source] of adapterProbes) virtual.set(path, source);
    const quiet = resolve(root, 'tests/arch/__domain_probe_quiet.ts');
    virtual.set(quiet, `// assertDomainClosure(raw);\nconst text='raw as TrustedDomain'; /* function f(v:unknown):v is TrustedDomain{} */`);
    const api = new API({ cwd: root, fs: { readFile: path => virtual.get(path), fileExists: path => virtual.has(path) ? true : undefined } });
    try {
        const snapshot = api.updateSnapshot({ openFiles: [...virtual.keys()] });
        for (const [path, source] of virtual) {
            const ast = snapshot.getDefaultProjectForFile(path)!.program.getSourceFile(path)!;
            if (adapterProbes.some(([probe]) => probe === path)) {
                for (const owner of ['l1/parsers/gemini/shared/contentAdapter.ts', 'l1/parsers/gemini/shared/structuredContentAdapter.ts', 'l1/sniffer/gemini/captureReceiver.ts'])
                    assert.ok(trustBoundaryViolations(ast, owner).length > 0, `${owner}: ${source}`);
                continue;
            }
            for (const owner of ['l2/probe.ts', 'l3a/probe.ts', 'l3b/probe.ts', 'application/probe.ts', 'l4/probe.ts']) {
                const issues = trustBoundaryViolations(ast, owner);
                if (path === quiet) assert.deepEqual(issues, []);
                else assert.ok(issues.length > 0, `${owner}: ${source}`);
            }
        }
        // Even an otherwise authorized module cannot add a double trust assertion.
        const double = snapshot.getDefaultProjectForFile([...virtual.keys()][12])!.program.getSourceFile([...virtual.keys()][12])!;
        assert.ok(trustBoundaryViolations(double, 'l2/readConversation.ts').some(issue => issue.includes('double trust assertion')));
        snapshot.dispose();
    } finally { api.close(); }
});


test('only the authenticated Detail IPC owner can decode detached bodies, and it cannot assert types', () => {
    const owner = 'runtime/background/domainStorageHandler.ts';
    const sources = [
        `import {restoreDomainDetail as decode} from './validation';decode(raw);`,
        `const detail=raw as Parameters<typeof ingestDetail>[2];`,
        `const detail=raw!;`,
    ];
    const virtual = new Map(sources.map((source, index) => [resolve(root, `tests/arch/__ipc_ingress_probe_${index}.ts`), source]));
    const api = new API({ cwd: root, fs: { readFile: path => virtual.get(path), fileExists: path => virtual.has(path) ? true : undefined } });
    try {
        const snapshot = api.updateSnapshot({ openFiles: [...virtual.keys()] });
        for (const [index, path] of [...virtual.keys()].entries()) {
            const ast = snapshot.getDefaultProjectForFile(path)!.program.getSourceFile(path)!;
            const issues = trustBoundaryViolations(ast, owner);
            if (index === 0) {
                assert.deepEqual(issues, []);
                for (const other of ['runtime/background/other.ts', 'application/probe.ts']) {
                    assert.ok(trustBoundaryViolations(ast, other).some(issue => issue.includes('unauthorized restoreDomainDetail')));
                }
            } else assert.ok(issues.some(issue => issue.includes('without assertions')));
        }
        snapshot.dispose();
    } finally { api.close(); }
});
