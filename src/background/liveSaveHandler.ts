// src/background/liveSaveHandler.ts - Live Save via File System Handle execution and disk state probing

import { getStoredDirHandle, clearStoredDirHandle } from '../core/storage/idbHandleStore.js';
import { FsWriter } from '../core/engine/writers/fsWriter.js';
import { ChatFormatter } from '../core/engine/chatFormatter.js';
import { GeminiUtils } from '../core/utils/utils.js';
import { StorageService } from '../core/storage/storageService.js';

export async function markDirDeletedInConfig(): Promise<void> {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        try {
            const data = await chrome.storage.local.get('live_save_config');
            const cur = data?.live_save_config || {};
            await chrome.storage.local.set({
                live_save_config: {
                    ...cur,
                    enabledDisk: false,
                    dirName: '',
                    dirError: 'not_found'
                }
            });
        } catch {
            /* ignore */
        }
    }
}

export interface LiveSaveResult {
    ok: boolean;
    handleName?: string;
    targetFile?: string;
    error?: string;
    details?: string;
}

export function base64ToUint8Array(base64: string): Uint8Array {
    if (!base64 || typeof base64 !== 'string') return new Uint8Array(0);
    if (typeof Buffer !== 'undefined' && typeof (Buffer as any).from === 'function') {
        const buf = Buffer.from(base64, 'base64');
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

export async function handleLiveSaveViaHandle(payload: any, accountSlot: string = 'u0'): Promise<LiveSaveResult> {
    try {
        const { chat, safeTitle, nid, fileName, assets } = payload || {};
        const handle = await getStoredDirHandle();
        if (!handle) {
            return { ok: false, error: 'no_dir_handle' };
        }

        if (handle.queryPermission) {
            const perm = await handle.queryPermission({ mode: 'readwrite' });
            if (perm !== 'granted') {
                return { ok: false, error: 'permission_not_granted' };
            }
        }

        // Verify the directory physically exists on disk before proceeding
        try {
            for await (const _ of handle.keys()) break;
        } catch (probeErr: any) {
            if (probeErr?.name === 'NotFoundError' || probeErr?.message?.includes('not be found') || probeErr?.message?.includes('NotFoundError')) {
                console.warn('[Background:liveSave] Target directory was deleted on disk:', probeErr);
                await clearStoredDirHandle();
                await markDirDeletedInConfig();
                return { ok: false, error: 'dir_not_found', details: probeErr?.message };
            }
        }

        const FsWriterCls = (typeof FsWriter !== 'undefined' && FsWriter)
            ? ((FsWriter as any).FsWriter || FsWriter)
            : null;
        if (!FsWriterCls) {
            return { ok: false, error: 'no_fswriter' };
        }

        const writer = new FsWriterCls(handle, 'gemini_export');
        await writer.init();

        const sanitizedTitle = GeminiUtils?.sanitizeFileName
            ? GeminiUtils.sanitizeFileName(safeTitle)
            : safeTitle.replace(/[\\/:*?"<>|]/g, '_');
        const cid6 = String(nid || '').replace(/^c_/, '').slice(-6);
        const targetFile = fileName || `${sanitizedTitle}_${cid6}.md`;

        const FormatterCls = (typeof ChatFormatter !== 'undefined' && ChatFormatter)
            ? ChatFormatter
            : null;
        const markdown = FormatterCls?.toMarkdown
            ? FormatterCls.toMarkdown({ ...chat, title: safeTitle, id: nid })
            : `# ${safeTitle}\n\n${JSON.stringify(chat?.messages || [], null, 2)}`;

        await writer.writeFile('', targetFile, markdown);

        if (Array.isArray(assets) && assets.length > 0) {
            for (const asset of assets) {
                if (asset && asset.fileName) {
                    let fileData: Uint8Array | null = null;
                    if (asset.base64 && typeof asset.base64 === 'string') {
                        try {
                            fileData = base64ToUint8Array(asset.base64);
                        } catch (b64Err) {
                            console.warn('[Background:liveSave] Failed to decode base64 for asset:', asset.fileName, b64Err);
                        }
                    } else if (asset.buffer instanceof ArrayBuffer) {
                        fileData = new Uint8Array(asset.buffer);
                    } else if (ArrayBuffer.isView(asset.buffer)) {
                        fileData = new Uint8Array(asset.buffer.buffer, asset.buffer.byteOffset, asset.buffer.byteLength);
                    } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(asset.buffer)) {
                        fileData = new Uint8Array(asset.buffer.buffer, asset.buffer.byteOffset, asset.buffer.byteLength);
                    }

                    if (!fileData || fileData.byteLength === 0) {
                        console.warn('[Background:liveSave] Skipping asset with no valid binary data:', asset.fileName);
                        continue;
                    }

                    try {
                        await writer.writeFile(asset.subDir || 'assets', asset.fileName, fileData);
                    } catch (assetErr) {
                        console.warn('[Background:liveSave] Failed to write asset:', asset.fileName, assetErr);
                    }
                }
            }
        }

        const now = Date.now();
        if (typeof chrome !== 'undefined' && chrome.storage?.local) {
            try {
                const data = await chrome.storage.local.get('live_save_config');
                const cur = data?.live_save_config || {};
                await chrome.storage.local.set({
                    live_save_config: {
                        ...cur,
                        lastSavedAt: now,
                        lastSavedTitle: safeTitle,
                        dirError: null
                    }
                });
            } catch {
                /* best-effort storage update */
            }
        }

        // Mark conversation as exported in exportedIds SSoT
        try {
            const slot = accountSlot || 'u0';
            if (typeof StorageService !== 'undefined' && StorageService?.saveExportRecord) {
                await StorageService.saveExportRecord(slot, nid, {
                    exportedAt: new Date(now).toISOString(),
                    title: safeTitle,
                    format: 'markdown'
                });
            }
        } catch (e) {
            console.warn('[Background:liveSave] Failed to mark conversation as exported:', e);
        }

        return { ok: true, handleName: handle.name, targetFile };
    } catch (err: any) {
        console.warn('[Background:liveSave] liveSaveViaHandle error:', err);
        const isNotFound = err?.name === 'NotFoundError' || err?.message?.includes('could not be found') || err?.message?.includes('NotFoundError');
        if (isNotFound) {
            await clearStoredDirHandle();
            await markDirDeletedInConfig();
            return { ok: false, error: 'dir_not_found', details: err?.message };
        }
        return { ok: false, error: err?.message || String(err) };
    }
}
