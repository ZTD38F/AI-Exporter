import { ensureV2Ready as ensureWorkerReady } from '../background/readiness.js';

/** The Worker awaits its shared promise directly; other contexts use its IPC boundary. */
export async function ensureV2Ready(): Promise<void> {
    if (typeof window === 'undefined' && typeof location !== 'undefined' && location.protocol === 'chrome-extension:') {
        await ensureWorkerReady();
        return;
    }
    const response: unknown = await chrome.runtime.sendMessage({ action: 'ensureV2Ready' });
    if (!response || typeof response !== 'object' || !('ok' in response) || response.ok !== true) {
        throw new Error(response && typeof response === 'object' && 'error' in response ? String(response.error) : 'Runtime unavailable');
    }
}
