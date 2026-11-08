import { getStoredSettings, patchStoredSettings } from '../../l3a/storageService.js';
import type { ExportFormat, ExportDelivery } from '../export/types.js';

export interface GlobalSettings {
    defaultFormat: ExportFormat;
    skipExported: boolean;
    includeAssets: boolean;
    enabledDisk: boolean;
    /** Manual export destination also gates background Live Save. */
    exportDelivery?: ExportDelivery;
    developerMode: boolean;
    theme?: 'dark' | 'light';
    language?: 'zh' | 'en';
    badgePosition?: { left: number; top: number };
    lastSeenFeatureVersion?: string;
    takeoutPromptCompleted?: true;
    ratingPromptDismissed?: true;
    /** Automatically suggested large-batch folder delivery has already been shown. */
    directWritePromptCompleted?: true;
}

export async function getSettings(): Promise<GlobalSettings> {
    const stored = await getStoredSettings();
    return { defaultFormat: 'markdown', skipExported: true,
        includeAssets: false, enabledDisk: false, developerMode: false,
        ...stored,
        // Existing Live Save users continue in folder mode; new users default to browser download.
        exportDelivery: stored.exportDelivery ?? (stored.enabledDisk ? 'folderWriter' : 'browserDownload') };
}
export function updateSettings(patch: Partial<GlobalSettings>): Promise<void> {
    return patchStoredSettings(patch);
}
export function isLiveSaveEffective(settings: GlobalSettings, directoryAvailable: boolean): boolean {
    return settings.enabledDisk && settings.exportDelivery === 'folderWriter'
        && settings.defaultFormat === 'markdown' && directoryAvailable;
}
