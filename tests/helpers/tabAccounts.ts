/** Explicit tab bindings; URL slots are deliberately irrelevant. */
export function bindTabAccounts(bindings: Record<number, string>): void {
    const original = chrome.tabs.sendMessage;
    chrome.runtime ??= {} as typeof chrome.runtime;
    chrome.tabs.sendMessage = ((tabId: number, message: { action?: string }, callback: (reply: unknown) => void) => {
        if (message.action === 'getAccountContext') {
            callback({ ok: true, accountContext: bindings[tabId] ? { providerId: 'gemini', accountId: bindings[tabId] } : null });
            return;
        }
        return Reflect.apply(original, chrome.tabs, [tabId, message, callback]);
    }) as typeof chrome.tabs.sendMessage;
}
