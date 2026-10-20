/**
 * src/core/export/typst/mitex/mitexLoader.ts
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

function getNodeModule(name: string): any {
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

function getWasmPathInNode(): string {
    const path = getNodeModule('node:path');
    const fs = getNodeModule('node:fs');
    if (!path || !fs) {
        throw new Error('Node.js modules node:path and node:fs are not available in current environment.');
    }

    // Try relative to current file
    const candidatePaths = [
        path.join(__dirname, 'vendor', 'mitex_wasm_bg.wasm'),
        path.join(__dirname, '..', 'src', 'core', 'export', 'typst', 'mitex', 'vendor', 'mitex_wasm_bg.wasm'),
        path.join(process.cwd(), 'src', 'core', 'export', 'typst', 'mitex', 'vendor', 'mitex_wasm_bg.wasm'),
    ];

    for (const p of candidatePaths) {
        if (fs.existsSync(p)) return p;
    }

    throw new Error(`MiTeX WASM binary not found in candidate paths: ${candidatePaths.join(', ')}`);
}

function initNodeSync(): void {
    if (isReady) return;
    const fs = getNodeModule('node:fs');
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
            const fs = getNodeModule('node:fs');
            const wasmPath = getWasmPathInNode();
            bytes = fs.readFileSync(wasmPath);
        } else if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
            const url = chrome.runtime.getURL('src/core/export/typst/mitex/vendor/mitex_wasm_bg.wasm');
            const resp = await fetch(url);
            if (!resp.ok) {
                throw new Error(`Failed to load MiTeX WASM from extension URL ${url}: ${resp.status}`);
            }
            bytes = await resp.arrayBuffer();
        } else {
            throw new Error('Unsupported runtime for automatic MiTeX WASM loading; pass wasmSource explicitly.');
        }

        const wasmRes: any = await WebAssembly.instantiate(bytes, { './mitex_wasm_bg.js': bg });
        const wasmInstance = wasmRes.instance ?? wasmRes;
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

export function mitexConvertText(latex: string): string {
    if (!isReady) {
        if (typeof process !== 'undefined' && process.versions?.node) {
            initNodeSync();
        } else {
            throw new Error('MiTeX WASM has not been initialized. Call await initMitexWasm() before converting.');
        }
    }

    return bg.convert_text(latex, EMPTY_SPEC);
}

export function resetMitexForTesting(): void {
    isReady = false;
    initPromise = null;
    initFailureSimulator = null;
}
