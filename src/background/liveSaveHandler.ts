import { getStoredDirHandle, clearStoredDirHandle } from '../core/storage/idbHandleStore.js';
import { setLiveConfig, isLiveSaveFormatSupported } from '../core/storage/liveStorageManager.js';
import { createLiveSaveWriter, writeLiveSaveMarkdown, formatLiveSaveMarkdown } from '../core/engine/liveSaveWriter.js';
import { StorageService } from '../core/storage/storageService.js';
import { completeConversationExport } from '../core/engine/export/exportCompletion.js';
import { getEffectiveTimestamp, toTimestampMs } from '../core/utils/utils.js';
import { sanitizeFileName, sanitizeRelativePath, normId } from '../core/utils/pathUtils.js';

export async function markDirDeletedInConfig(): Promise<void> {
    try {
        await setLiveConfig({
            enabledDisk: false,
            dirName: '',
            dirError: 'not_found'
        });
    } catch {
        /* ignore */
    }
}

export interface LiveSaveResult {
    ok: boolean;
    handleName?: string;
    targetFile?: string;
    error?: string;
    details?: string;
    // Phase A (P1-2): 附件失败明细。ok=false + failedAssets 非空 = 主 md 已落盘、
    // 部分附件失败（partial），调用方应打 badge 警告而非静默标成功。
    failedAssets?: Array<{ file: string; error: string }>;
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

const _liveWriteLocks = new Map<string, Promise<any>>();

export function withLiveSaveLock<T>(key: string, op: () => Promise<T>): Promise<T> {
    const prev = _liveWriteLocks.get(key) || Promise.resolve();
    let releaseGate!: () => void;
    const gate = new Promise<void>((res) => { releaseGate = res; });
    _liveWriteLocks.set(key, gate);

    return prev.then(
        () => op(),
        () => op()
    ).finally(() => {
        releaseGate();
        if (_liveWriteLocks.get(key) === gate) {
            _liveWriteLocks.delete(key);
        }
    });
}

export async function handleLiveSaveViaHandle(payload: any, accountSlot: string = 'u0'): Promise<LiveSaveResult> {
    try {
        if (!await isLiveSaveFormatSupported()) return { ok: false, error: 'live_save_requires_markdown' };
        const { chat, safeTitle, nid, fileName, assets, failedAssets: upstreamFailures } = payload || {};
        const handle = await getStoredDirHandle();
        if (!handle) {
            return { ok: false, error: 'no_dir_handle' };
        }

        if (handle.queryPermission) {
            try {
                const perm = await handle.queryPermission({ mode: 'readwrite' });
                if (perm !== 'granted') {
                    console.info('[Background:liveSave] Handle permission not granted (prompt needed)');
                    await setLiveConfig({ dirError: 'permission_prompt_needed' });
                    return { ok: false, error: 'permission_prompt_needed' };
                }
            } catch (permErr: any) {
                console.warn('[Background:liveSave] queryPermission threw, prompt needed:', permErr);
                await setLiveConfig({ dirError: 'permission_prompt_needed' });
                return { ok: false, error: 'permission_prompt_needed' };
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
            if (probeErr?.name === 'NotAllowedError' || probeErr?.name === 'SecurityError') {
                console.info('[Background:liveSave] Directory probe threw NotAllowedError, prompt needed');
                await setLiveConfig({ dirError: 'permission_prompt_needed' });
                return { ok: false, error: 'permission_prompt_needed' };
            }
        }

        // Shared live-save writer: filename format + markdown formatting + write.
        // Serialized through withLiveSaveLock per file to prevent concurrent createWritable
        // collisions (NoModificationAllowedError) when multiple tabs write simultaneously.
        const fileLockKey = String(fileName || nid || safeTitle || chat?.id || 'live_save');

        const { targetFile, failedAssets } = await withLiveSaveLock(fileLockKey, async () => {
            const writer = await createLiveSaveWriter(handle);

            const target = await writeLiveSaveMarkdown(
                writer,
                { chat, safeTitle, nid },
                {},
                { fileName }
            );

            const failures: Array<{ file: string; error: string }> = Array.isArray(upstreamFailures)
                ? upstreamFailures.filter(f => typeof f?.file === 'string' && typeof f?.error === 'string').map(f => ({ file: f.file, error: f.error }))
                : [];
            if (Array.isArray(assets) && assets.length > 0) {
                for (const asset of assets) {
                    if (asset && asset.fileName) {
                        let fileData: Uint8Array | null = null;
                        if (asset.base64 && typeof asset.base64 === 'string') {
                            try {
                                fileData = base64ToUint8Array(asset.base64);
                            } catch (b64Err) {
                                const msg = b64Err instanceof Error ? b64Err.message : String(b64Err);
                                console.warn('[Background:liveSave] Failed to decode base64 for asset:', asset.fileName, b64Err);
                                failures.push({ file: asset.fileName, error: `base64 decode failed: ${msg}` });
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
                            failures.push({ file: asset.fileName, error: 'no valid binary data' });
                            continue;
                        }

                        try {
                            const safeSubDir = sanitizeRelativePath(asset.subDir || 'assets', 'assets');
                            const safeAssetFileName = sanitizeFileName(asset.fileName, 'attachment');
                            await writer.writeFile(safeSubDir, safeAssetFileName, fileData);
                        } catch (assetErr) {
                            const msg = assetErr instanceof Error ? assetErr.message : String(assetErr);
                            console.warn('[Background:liveSave] Failed to write asset:', asset.fileName, assetErr);
                            failures.push({ file: asset.fileName, error: msg });
                        }
                    }
                }
            }
            return { targetFile: target, failedAssets: failures };
        });

        const now = Date.now();
        try {
            await setLiveConfig({
                lastSavedAt: now,
                lastSavedTitle: safeTitle,
                dirError: null
            });
        } catch {
            /* best-effort storage update */
        }

        // Shared export completion: builds standardized ExportRecord and promotes title in gemini_conversations.
        // Phase A (P1-2): 主 md 成功即写记录；附件有失败则标 partial（与导出管线
        // sessionRecovery 的 partial 惯例对齐），保证下次增量不跳过、可重试。
        try {
            let convInStore: any = null;
            try {
                const list = await StorageService.getConversations(accountSlot || 'u0');
                convInStore = list.find((c: any) => normId(c.id) === nid);
            } catch {}

            let turnTsFromMsgs = 0;
            if (Array.isArray(chat?.messages)) {
                for (const m of chat.messages) {
                    const mt = toTimestampMs(m?.timestamp);
                    if (mt && mt > turnTsFromMsgs) turnTsFromMsgs = mt;
                }
            }
            const effectiveChatTime = (chat as any)?.chatTime || turnTsFromMsgs || (chat as any)?.updatedAt || (chat as any)?.timestamp || convInStore?.updatedAt || convInStore?.timestamp || null;
            const effectiveMsgCount = (Array.isArray(chat?.messages) ? chat.messages.length : 0) || convInStore?.messageCount || (chat as any)?.messageCount || 0;

            await completeConversationExport(
                StorageService,
                accountSlot || 'u0',
                {
                    conversation: {
                        ...convInStore,
                        ...chat,
                        messageCount: effectiveMsgCount,
                        ...(effectiveChatTime ? {
                            chatTime: effectiveChatTime,
                            updatedAt: effectiveChatTime,
                            timestamp: effectiveChatTime
                        } : {})
                    },
                    conversationId: nid,
                    format: 'markdown',
                    exportedAt: now,
                    failedAssets,
                    titleCandidate: safeTitle,
                    titleProvenance: (chat as any)?.titleSource || convInStore?.titleSource,
                    titles: (chat as any)?.titles || convInStore?.titles,
                    messageCount: effectiveMsgCount,
                    chatTime: effectiveChatTime
                }
            );
        } catch (e) {
            console.warn('[Background:liveSave] Failed to mark conversation as exported:', e);
        }

        return { ok: failedAssets.length === 0, failedAssets, handleName: handle.name, targetFile };
    } catch (err: any) {
        console.warn('[Background:liveSave] liveSaveViaHandle error:', err);
        const isNotFound = err?.name === 'NotFoundError' || err?.message?.includes('could not be found') || err?.message?.includes('NotFoundError');
        if (isNotFound) {
            await clearStoredDirHandle();
            await markDirDeletedInConfig();
            return { ok: false, error: 'dir_not_found', details: err?.message };
        }
        if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') {
            console.info('[Background:liveSave] liveSaveViaHandle caught permission error, prompt needed');
            await setLiveConfig({ dirError: 'permission_prompt_needed' });
            return { ok: false, error: 'permission_prompt_needed' };
        }
        return { ok: false, error: err?.message || String(err) };
    }
}
