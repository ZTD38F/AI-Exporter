import { resolveCurrentAccount, isCurrentAccount } from './accountContext.js';
import { extractConversationIdFromUrl } from '../../shared/utils/pathUtils.js';
import { AssetFetcher, type AssetFetchResponse } from '../capabilities/assetFetcher.js';
import { registerCleanup } from './cleanupRegistry.js';
import { getExtensionVersion } from '../../shared/utils/constants.js';

// Bound the existing flat L1 DTO before Chrome constructs its JSON message.
// Count conservatively without allocating another encoded/serialized copy.
function assertResourceIpcSize(result: AssetFetchResponse): void {
    if (result.size !== undefined && result.size > 50 * 1024 * 1024) throw new Error('Resource exceeds IPC size limit');
    let bytes = 2;
    for (const [key, value] of Object.entries(result)) {
        bytes += key.length * 6 + 16;
        if (typeof value === 'string') {
            for (let i = 0; i < value.length; i++) {
                const code = value.charCodeAt(i);
                bytes += code < 32 || code > 126 ? 6 : code === 34 || code === 92 ? 2 : 1;
                if (bytes > 60 * 1024 * 1024) throw new Error('Resource exceeds IPC size limit');
            }
        } else if (value !== null && value !== undefined && typeof value !== 'boolean' && typeof value !== 'number') {
            throw new Error('Resource response is not a flat JSON payload');
        }
    }
    if (bytes > 60 * 1024 * 1024) throw new Error('Resource exceeds IPC size limit');
}
function allowedAssetUrl(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && /(^|\.)(googleusercontent\.com|gstatic\.com|googleapis\.com|google\.com)$/.test(url.hostname);
    } catch { return false; }
}
export function init(): void {
    const listener = (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => {
        if (!message || typeof message !== 'object' || !('action' in message)
            || !['getAccountContext', 'ping', 'getFileBlob', 'getImageBlob'].includes(String(message.action))) return false;
        let responded = false;
        const respond = (value: unknown) => { if (!responded) { responded = true; sendResponse(value); } };
        void (async () => {
            try {
                if (sender.id !== chrome.runtime.id) throw new Error('Foreign extension sender');
                if (message.action === 'ping') { respond({ ok: true, version: getExtensionVersion() }); return; }
                const href = location.href;
                const account = await resolveCurrentAccount();
                if (location.href !== href || account && !isCurrentAccount(account)) throw new Error('Page changed while resolving account');
                if (message.action === 'getAccountContext') {
                    respond({ ok: true, accountContext: account, conversationId: extractConversationIdFromUrl(new URL(href).pathname) }); return;
                }
                if (!account || !('accountId' in message) || message.accountId !== account.accountId) throw new Error('Requested account does not match this Tab');
                if (!('url' in message) || !allowedAssetUrl(message.url)) throw new Error('Asset URL not allowed');
                const handler = message.action === 'getFileBlob' ? AssetFetcher.handleGetFileBlob : AssetFetcher.handleGetImageBlob;
                let result: AssetFetchResponse | undefined;
                await handler({ url: message.url }, value => { result = value; });
                if (result === undefined) throw new Error('Resource operation returned no result');
                const fresh = await resolveCurrentAccount();
                if (fresh?.accountId !== account.accountId || !isCurrentAccount(account)) throw new Error('Account changed during resource acquisition');
                assertResourceIpcSize(result);
                respond(result);
            } catch (error) { respond({ ok: false, success: false, error: error instanceof Error ? error.message : String(error) }); }
        })();
        return true;
    };
    chrome.runtime.onMessage.addListener(listener);
    registerCleanup(() => chrome.runtime.onMessage.removeListener(listener));
}
export const MessageRouter = { init };
