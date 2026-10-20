let sessionAccessFailed = false;
let credentialWriteChain: Promise<void> = Promise.resolve();
const CREDENTIAL_MAP_LOCK = 'gemini-exporter:write:credential-map';

/** Serialize complete credential-map read/modify/write cycles across contexts. */
export function withCredMapLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = () => {
        try {
            const locks = typeof navigator !== 'undefined' ? (navigator as any).locks : null;
            if (locks?.request) return locks.request(CREDENTIAL_MAP_LOCK, fn) as Promise<T>;
        } catch { /* non-browser contexts use the local chain */ }
        return fn();
    };
    const task = credentialWriteChain.then(run, run);
    credentialWriteChain = task.then(() => undefined, () => undefined);
    return task;
}

export function getCredStorage(): chrome.storage.StorageArea | null {
    if (typeof chrome !== 'undefined' && chrome.storage) {
        if (!sessionAccessFailed && chrome.storage.session) return chrome.storage.session;
        return chrome.storage.local;
    }
    return null;
}

export function markCredSessionAccessFailed(): void {
    sessionAccessFailed = true;
}
