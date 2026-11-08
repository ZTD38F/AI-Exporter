type DomainChangeListener = (accountId: string) => void | Promise<void>;
const listeners = new Set<DomainChangeListener>();

function deliver(listener: DomainChangeListener, accountId: string): void {
    // Delivery and view reads are independent of the committing caller, including failures.
    queueMicrotask(() => {
        try { void Promise.resolve(listener(accountId)).catch(() => {}); }
        catch { /* An observer must never invalidate a committed write. */ }
    });
}

export function observeDomainChanges(listener: DomainChangeListener): () => void {
    listeners.add(listener);
    const receive = (message: unknown, sender: chrome.runtime.MessageSender): void => {
        if (sender.id !== chrome.runtime.id || sender.tab
            || sender.url && !sender.url.startsWith(chrome.runtime.getURL(''))
            || !message || typeof message !== 'object' || !('action' in message) || message.action !== 'domainChanged'
            || !('accountId' in message) || typeof message.accountId !== 'string') return;
        deliver(listener, message.accountId);
    };
    if (typeof chrome !== 'undefined') chrome.runtime?.onMessage?.addListener(receive);
    return () => {
        listeners.delete(listener);
        if (typeof chrome !== 'undefined') chrome.runtime?.onMessage?.removeListener(receive);
    };
}

/** Runtime invalidation only: UI rereads committed L3a facts; no Domain payload crosses this channel. */
export function notifyDomainChanged(accountId: string): void {
    // runtime.sendMessage excludes the sending context, so local views also receive invalidation.
    for (const listener of listeners) deliver(listener, accountId);
    try {
        if (typeof chrome === 'undefined' || typeof chrome.runtime?.sendMessage !== 'function') return;
        void Promise.resolve(chrome.runtime.sendMessage({ action: 'domainChanged', accountId })).catch(() => {});
    } catch { /* No open extension view is a normal outcome after a successful commit. */ }
}
