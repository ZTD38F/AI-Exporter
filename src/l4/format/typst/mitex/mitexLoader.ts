/**
 * src/l4/format/typst/mitex/mitexLoader.ts
 *
 * Environment-agnostic loader for MiTeX WASM module.
 * Supports:
 * 1. Node.js runtime (synchronous / asynchronous instantiation via fs.readFileSync)
 * 2. Chrome MV3 Extension / Browser runtime (via fetch / chrome.runtime.getURL or provided bytes)
 *
 * 100% offline, zero network access required.
 */

import * as bg from './vendor/mitex_wasm_bg.js';

const EMPTY_SPEC = new Uint8Array(0);

let isReady = false;
let initPromise: Promise<void> | null = null;
let initFailureSimulator: (() => Error | null) | null = null;

export function simulateMitexInitFailureForTesting(fn: (() => Error | null) | null): void {
    initFailureSimulator = fn;
}

type NodePath = Pick<typeof import('node:path'), 'join'>;
type NodeFs = Pick<typeof import('node:fs'), 'existsSync' | 'readFileSync'>;

function isNodePath(value: unknown): value is NodePath {
    return typeof value === 'object' && value !== null && 'join' in value && typeof value.join === 'function';
}

function isNodeFs(value: unknown): value is NodeFs {
    return typeof value === 'object' && value !== null
        && 'existsSync' in value && typeof value.existsSync === 'function'
        && 'readFileSync' in value && typeof value.readFileSync === 'function';
}

function loadRawModule(name: 'node:path' | 'node:fs'): unknown {
    if (typeof process !== 'undefined' && process.versions?.node) {
        try {
            if (typeof module !== 'undefined' && typeof module.require === 'function') {
                return module.require(name);
            }
            if (typeof require !== 'undefined') {
                return require(name);
            }
        } catch {
            return null;
        }
    }
    return null;
}

function getNodePath(): NodePath | null {
    const loaded = loadRawModule('node:path');
    return isNodePath(loaded) ? loaded : null;
}

function getNodeFs(): NodeFs | null {
    const loaded = loadRawModule('node:fs');
    return isNodeFs(loaded) ? loaded : null;
}

function getWasmPathInNode(): string {
    const path = getNodePath();
    const fs = getNodeFs();
    if (!path || !fs) {
        throw new Error('Node.js modules node:path and node:fs are not available in current environment.');
    }

    const wasmPath = path.join(__dirname, 'vendor', 'mitex_wasm_bg.wasm');
    if (fs.existsSync(wasmPath)) return wasmPath;
    throw new Error(`MiTeX WASM binary not found at ${wasmPath}`);
}

function initNodeSync(): void {
    if (isReady) return;
    const fs = getNodeFs();
    if (!fs) return;
    const wasmPath = getWasmPathInNode();
    const wasmBytes = fs.readFileSync(wasmPath);
    const wasmModule = new WebAssembly.Module(wasmBytes);
    const wasmInstance = new WebAssembly.Instance(wasmModule, { './mitex_wasm_bg.js': bg });
    bg.__wbg_set_wasm(wasmInstance.exports);
    isReady = true;
}

export function isMitexReady(): boolean {
    return isReady;
}

export async function initMitexWasm(wasmSource?: string | Uint8Array | ArrayBuffer): Promise<void> {
    if (initFailureSimulator) {
        const err = initFailureSimulator();
        if (err) throw err;
    }
    if (isReady) return;
    if (initPromise) return initPromise;

    const promise = (async () => {
        let bytes: Uint8Array | ArrayBuffer;

        if (wasmSource instanceof Uint8Array || wasmSource instanceof ArrayBuffer) {
            bytes = wasmSource;
        } else if (typeof wasmSource === 'string') {
            const resp = await fetch(wasmSource);
            if (!resp.ok) {
                throw new Error(`Failed to load MiTeX WASM from ${wasmSource}: ${resp.status} ${resp.statusText}`);
            }
            bytes = await resp.arrayBuffer();
        } else if (typeof process !== 'undefined' && process.versions?.node) {
            const fs = getNodeFs();
            const wasmPath = getWasmPathInNode();
            if (!fs) throw new Error('Node.js filesystem is unavailable');
            bytes = fs.readFileSync(wasmPath);
        } else if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
            const url = chrome.runtime.getURL('src/l4/format/typst/mitex/vendor/mitex_wasm_bg.wasm');
            const resp = await fetch(url);
            if (!resp.ok) {
                throw new Error(`Failed to load MiTeX WASM from extension URL ${url}: ${resp.status}`);
            }
            bytes = await resp.arrayBuffer();
        } else {
            throw new Error('Unsupported runtime for automatic MiTeX WASM loading; pass wasmSource explicitly.');
        }

        const wasmBytes = bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes);
        const wasmRes = await WebAssembly.instantiate(wasmBytes, { './mitex_wasm_bg.js': bg });
        const wasmInstance = wasmRes.instance;
        bg.__wbg_set_wasm(wasmInstance.exports);
        isReady = true;
    })();

    initPromise = promise;

    try {
        await promise;
    } catch (err) {
        initPromise = null;
        throw err;
    }
}

export function mitexConvertMath(latex: string): string {
    if (!isReady) {
        if (typeof process !== 'undefined' && process.versions?.node) {
            initNodeSync();
        } else {
            throw new Error('MiTeX WASM has not been initialized. Call await initMitexWasm() before converting.');
        }
    }

    return bg.convert_math(latex, EMPTY_SPEC);
}

export function resetMitexForTesting(): void {
    isReady = false;
    initPromise = null;
    initFailureSimulator = null;
}
