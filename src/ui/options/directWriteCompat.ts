// Canonical Direct Write prompt semantics preserved across Workbench recovery changes.

export function installCanonicalDirectWritePrompt(Dialogs: any, DirHandle: any): void {
    if (!Dialogs || Dialogs.__canonicalDirectWriteInstalled || typeof Dialogs.showDirectWritePrompt !== 'function') return;
    Dialogs.__canonicalDirectWriteInstalled = true;

    const original = Dialogs.showDirectWritePrompt.bind(Dialogs);
    Dialogs.showDirectWritePrompt = async (
        count: number,
        onFolder: () => void | Promise<void>,
        onZip: () => void | Promise<void>
    ): Promise<void> => {
        // Canonical main behavior: an existing directory handle suppresses the
        // Direct Write recommendation entirely; ZIP export proceeds unchanged.
        if (DirHandle && typeof DirHandle.getDirHandle === 'function' && DirHandle.getDirHandle()) {
            await onZip();
            return;
        }

        const suppressKey = 'gemini_suppress_direct_write_prompt';
        try {
            const stored = await chrome.storage.local.get([suppressKey]);
            if (stored?.[suppressKey]) {
                await onZip();
                return;
            }
        } catch (error) {
            console.warn('[GemExporter:storage] Storage operation failed:', error);
        }

        const suppressOnce = async (): Promise<void> => {
            try {
                await chrome.storage.local.set({ [suppressKey]: true });
            } catch (error) {
                console.warn('[GemExporter:storage] Storage operation failed:', error);
            }
        };

        original(
            count,
            async () => {
                await suppressOnce();
                try {
                    await chrome.storage.local.set({ gemini_export_zip: false });
                } catch (error) {
                    console.warn('[GemExporter:storage] Storage operation failed:', error);
                }
                await onFolder();
            },
            async () => {
                await suppressOnce();
                await onZip();
            }
        );
    };
}
