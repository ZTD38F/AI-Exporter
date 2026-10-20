// Canonical Direct Write prompt semantics preserved across Workbench recovery changes.
import { isDirectWritePromptSuppressed, setDirectWritePromptSuppressed, setZipPreference } from '../../core/storage/userPreferences.js';

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

        try {
            const suppressed = await isDirectWritePromptSuppressed();
            if (suppressed) {
                await onZip();
                return;
            }
        } catch (error) {
            console.warn('[GemExporter:storage] Storage operation failed:', error);
        }

        const suppressOnce = async (): Promise<void> => {
            try {
                await setDirectWritePromptSuppressed(true);
            } catch (error) {
                console.warn('[GemExporter:storage] Storage operation failed:', error);
            }
        };

        original(
            count,
            async () => {
                await suppressOnce();
                try {
                    await setZipPreference(false);
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
