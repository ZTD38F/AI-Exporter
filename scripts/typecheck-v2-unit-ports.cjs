#!/usr/bin/env node
'use strict';
/**
 * Check only the isolated v2 unit-port mocks against real owner definitions.
 * TypeScript 7 is a native compiler with no in-process JS Compiler API such
 * as ts.sys or createProgram. Use the supported tsc CLI instead, retaining the
 * project compiler options and avoiding unrelated repository-wide diagnostics.
 */
const { spawnSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const root = path.resolve(__dirname, '..');
const relativeFiles = [
    'tests/helpers/l1V2UnitMocks.ts',
    'tests/helpers/l2V2UnitHarness.ts',
    'tests/l2-v2-unit-mocked.test.ts',
    'tests/helpers/l3aStorageUnitEnvironment.ts',
    'tests/helpers/l3bUnitHarness.ts',
    'tests/helpers/l4V2Fixtures.ts',
    'tests/helpers/applicationHarness.ts',
    'tests/helpers/runtimeV2ContractMocks.ts',
    'tests/helpers/uiV2Mocks.ts',
    'tests/migration-v2-mocked.test.ts',
];
const files = relativeFiles.map(file => path.join(root, file));
const included = new Set(files.map(file => path.resolve(file)));
const temporary = mkdtempSync(path.join(os.tmpdir(), 'gemini-v2-unit-ports-'));
try {
    const configPath = path.join(temporary, 'tsconfig.json');
    writeFileSync(configPath, JSON.stringify({
        extends: path.join(root, 'tsconfig.json'),
        files,
        include: [],
        exclude: [],
        compilerOptions: { noEmit: true },
    }));
    const command = path.join(root, 'node_modules', '.bin', 'tsc');
    const run = spawnSync(command, ['--project', configPath, '--pretty', 'false'], {
        cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    });
    if (run.error) throw run.error;
    const output = [run.stdout, run.stderr].filter(Boolean).join('\n');
    const diagnostics = output.split(/\r?\n/).filter(line => /\berror TS\d+:/.test(line));
    const fileOf = line => /^\s*(.+?)\(\d+,\d+\): error TS\d+:/.exec(line)?.[1];
    const scoped = diagnostics.filter(line => {
        const file = fileOf(line);
        return file !== undefined && included.has(path.resolve(root, file));
    });
    if (scoped.length) {
        process.stderr.write(scoped.join('\n') + '\n');
        process.exitCode = 1;
    } else if (run.status !== 0 && !diagnostics.length) {
        // Compiler configuration and process failures are never suppressed.
        process.stderr.write(output + '\n');
        process.exitCode = run.status ?? 1;
    } else {
        console.log('V2 unit-port types: ' + files.length +
            ' mock/test files checked against actual module definitions; 0 scoped diagnostics' +
            (diagnostics.length ? ' (' + diagnostics.length + ' unrelated diagnostics in imported files)' : ''));
    }
} finally {
    rmSync(temporary, { recursive: true, force: true });
}
