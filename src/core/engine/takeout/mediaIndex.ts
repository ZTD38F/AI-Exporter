import { sameGenerationEvent } from '../generatedMediaIdentity.js';
import type { GeneratedMediaIdentity } from '../../../types/conversation.js';
import { normId as utilsNormId } from "../../utils/utils.js";

export interface TakeoutStore {
    mediaMap: Record<string, any>;
    globalMedia: Record<string, any>;
    convCache: Record<string, any>;
}

export interface MediaIndexModule {
    getStore: (slot?: string | null) => TakeoutStore;
    normId: (id?: string | null) => string;
    extractC2PATimestamp: (bufferOrArray: any) => number | null;
    getTakeoutOfflineChat: (chatId: string, slot?: string | null) => any;
    getTakeoutMediaForChat: (chatId: string, slot?: string | null) => any[];
    getTakeoutFallbackMedia: (chatId: string, filenameOrId: string, slot?: string | null, generation?: GeneratedMediaIdentity) => Promise<Uint8Array | null>;
    commitTakeoutData: (slot: string | null | undefined, data: TakeoutStore) => void;
    clearTakeoutData: (slot?: string | null) => void;
    __slotTakeouts: Map<string, TakeoutStore>;
}

const __slotTakeouts = new Map<string, TakeoutStore>();

function normSlot(slot?: string | null): string {
    return (slot && typeof slot === 'string' && slot.trim()) ? slot.trim() : 'u0';
}

export function getStore(slot?: string | null): TakeoutStore {
    const s = normSlot(slot);
    if (__slotTakeouts.has(s)) {
        return __slotTakeouts.get(s)!;
    }
    return { mediaMap: {}, globalMedia: {}, convCache: {} };
}

export const normId = utilsNormId;

    function extractC2PATimestamp(bufferOrArray: any): number | null {
        if (!bufferOrArray) return null;
        let str = '';
        if (typeof Buffer !== 'undefined' && Buffer.isBuffer(bufferOrArray)) {
            str = bufferOrArray.toString('utf8', 0, Math.min(bufferOrArray.length, 65536));
        } else if (bufferOrArray instanceof Uint8Array || ArrayBuffer.isView(bufferOrArray)) {
            const byteLen = (bufferOrArray as any).byteLength ?? (bufferOrArray as any).length ?? 0;
            const len = Math.min(byteLen, 65536);
            const view = new Uint8Array((bufferOrArray as any).buffer || bufferOrArray, (bufferOrArray as any).byteOffset || 0, len);
            str = new TextDecoder('utf-8', { fatal: false }).decode(view);
        } else if (typeof bufferOrArray === 'string') {
            str = bufferOrArray.slice(0, 65536);
        } else {
            return null;
        }
        const m = /(20\d{2})([01]\d)([0-3]\d)([0-2]\d)([0-5]\d)([0-5]\d)Z/.exec(str);
        if (!m || m.index === undefined) return null;
        // Require a trust marker near candidate timestamp to prevent false positives
        const windowStart = Math.max(0, m.index - 512);
        const near = str.slice(windowStart, m.index + 32);
        if (!/(c2pa|jumb|jxmp|xmp|dc:|exif|tiff|createDate|dateTimeOriginal|claim_generator)/i.test(near)) {
            return null;
        }
        const year = parseInt(m[1], 10);
        const month = parseInt(m[2], 10);
        const day = parseInt(m[3], 10);
        const hour = parseInt(m[4], 10);
        const min = parseInt(m[5], 10);
        const sec = parseInt(m[6], 10);
        if (month < 1 || month > 12 || day < 1 || day > 31 ||
            hour > 23 || min > 59 || sec > 60) return null;
        const t = Date.UTC(year, month - 1, day, hour, min, sec);
        const d = new Date(t);
        if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
            return null;
        }
        return t;
    }

    function getTakeoutOfflineChat(chatId: string, slot?: string | null): any {
        if (!chatId) return null;
        const nid = normId(chatId);
        return getStore(slot).convCache[nid] || null;
    }

    function getTakeoutMediaForChat(chatId: string, slot?: string | null): any[] {
        if (!chatId) return [];
        const nid = normId(chatId);
        const store = getStore(slot);
        return (store.mediaMap && store.mediaMap[nid]) || [];
    }

    async function getTakeoutFallbackMedia(chatId: string, filenameOrId: string, slot?: string | null, generation?: GeneratedMediaIdentity): Promise<Uint8Array | null> {
        if (!filenameOrId) return null;
        const nid = normId(chatId);
        const store = getStore(slot);
        const mediaMap = store.mediaMap;
        const globalMedia = store.globalMedia;
        if (generation) {
            if (generation.chatId && generation.chatId !== nid) return null;
            const matches = (mediaMap[nid] || []).filter((item: any) => {
                const gen = item.generation;
                if (!gen) return false;
                if (!sameGenerationEvent(gen, generation)) return false;
                const targetOrd = generation.imageOrdinal ?? 0;
                const itemOrd = gen.imageOrdinal ?? 0;
                return itemOrd === targetOrd;
            });
            if (matches.length === 1) {
                try {
                    const bytes = await matches[0].fileObj.async('uint8array');
                    return bytes?.length ? bytes : null;
                } catch { return null; }
            }
            return null;
        }
        const isGenericName = (s: string) => /^(?:image(?:[_-]?\d+)?|file(?:[_-]?\d+)?|asset(?:[_-]?\d+)?|media(?:[_-]?\d+)?|thumb(?:nail)?(?:[_-]?\d+)?|photo(?:[_-]?\d+)?|picture(?:[_-]?\d+)?|screenshot(?:[_-]?\d+)?)$/i.test(s);

        let target = String(filenameOrId).replace(/^.*[\\\/]/, '').trim();
        try { target = decodeURIComponent(target); } catch { /* intentional */ }
        let targetStem = target.replace(/\.[^/.]+$/, '').toLowerCase();
        let cleanTarget = target.replace(/^[0-9a-fA-F]{4,16}_+/, '').trim();
        let cleanTargetStem = targetStem.replace(/^[0-9a-fA-F]{4,16}_+/, '').trim();
        // Do NOT strip hash if the stem would collapse into a generic word like 'image' or 'file'!
        if (!isGenericName(cleanTargetStem)) {
            const stripped = cleanTargetStem.replace(/[-_][0-9a-fA-F]{6,16}$/i, '').trim();
            if (!isGenericName(stripped)) {
                cleanTargetStem = stripped;
            }
        }

        const convMedia = mediaMap[nid];
        if (convMedia && convMedia.length) {
            for (const item of convMedia) {
                const itemFilename = item.filename;
                const itemStem = itemFilename.replace(/\.[^/.]+$/, '').toLowerCase();
                if (itemFilename === target || itemFilename === cleanTarget || itemStem === targetStem || itemStem === cleanTargetStem) {
                    try {
                        const bin = await item.fileObj.async('uint8array');
                        if (bin && bin.length > 0) return bin;
                    } catch (e) {
                        if (typeof console !== 'undefined' && console.debug) console.debug('[GemExporter:mediaIndex.js]', e);
                    }
                }
            }

            // Pass 2: stem matching (ONLY for distinctive non-generic names).
            for (const item of convMedia) {
                const itemFilename = item.filename;
                const itemStem = itemFilename.replace(/\.[^/.]+$/, '').toLowerCase();
                let cleanItemStem = itemStem.replace(/^[0-9a-fA-F]{4,16}_+/, '').trim();
                if (!isGenericName(cleanItemStem)) {
                    const stripped = cleanItemStem.replace(/[-_][0-9a-fA-F]{6,16}$/i, '').trim();
                    if (!isGenericName(stripped)) {
                        cleanItemStem = stripped;
                    }
                }

                if (!isGenericName(cleanItemStem) && !isGenericName(cleanTargetStem) && !isGenericName(itemStem) && !isGenericName(targetStem)) {
                    if (cleanItemStem === cleanTargetStem || cleanItemStem === targetStem || itemStem === cleanTargetStem) {
                        try {
                            const bin = await item.fileObj.async('uint8array');
                            if (bin && bin.length > 0) return bin;
                        } catch (e) {
                            if (typeof console !== 'undefined' && console.debug) console.debug('[GemExporter:mediaIndex.js]', e);
                        }
                    }
                }
            }

            // Pass 3: Single-media fallback (if the conversation has EXACTLY ONE media item and target is generic)
            if (convMedia.length === 1 && (isGenericName(cleanTargetStem) || isGenericName(targetStem))) {
                try {
                    const bin = await convMedia[0].fileObj.async('uint8array');
                    if (bin && bin.length > 0) return bin;
                } catch (e) {
                    if (typeof console !== 'undefined' && console.debug) console.debug('[GemExporter:mediaIndex.js]', e);
                }
            }
        }

        if (!isGenericName(cleanTargetStem) && !isGenericName(targetStem)) {
            if (globalMedia[cleanTargetStem] || globalMedia[targetStem] || globalMedia[cleanTarget] || globalMedia[target]) {
                const fObj = globalMedia[cleanTargetStem] || globalMedia[targetStem] || globalMedia[cleanTarget] || globalMedia[target];
                try {
                    let bin = await fObj.async('uint8array');
                    if (bin && bin.length > 0) return bin;
                } catch (e) { if (typeof console !== 'undefined' && console.debug) console.debug('[GemExporter:mediaIndex.js]', e); }
            }
        }

        for (const [stem, fileObj] of Object.entries(globalMedia)) {
            const hasNid = nid && (stem.includes(nid) || ((fileObj as any).name && (fileObj as any).name.includes(nid)));
            let cleanStem = stem.replace(/^[0-9a-fA-F]{4,16}_+/, '').replace(/[-_][0-9a-fA-F]{6,16}$/i, '').trim();

            if (hasNid) {
                if (!isGenericName(cleanStem) && !isGenericName(cleanTargetStem) &&
                    (cleanStem === cleanTargetStem || stem === targetStem)) {
                    try {
                        let bin = await (fileObj as any).async('uint8array');
                        if (bin && bin.length > 0) return bin;
                    } catch (e) { if (typeof console !== 'undefined' && console.debug) console.debug('[GemExporter:mediaIndex.js]', e); }
                }
            } else if (!isGenericName(cleanTargetStem) && !isGenericName(cleanStem)) {
                if (cleanStem === cleanTargetStem || stem === targetStem) {
                    try {
                        let bin = await (fileObj as any).async('uint8array');
                        if (bin && bin.length > 0) return bin;
                    } catch (e) { if (typeof console !== 'undefined' && console.debug) console.debug('[GemExporter:mediaIndex.js]', e); }
                }
            }
        }

        return null;
    }

    function commitTakeoutData(slot: string | null | undefined, { mediaMap, globalMedia, convCache }: TakeoutStore): void {
        const s = normSlot(slot);
        __slotTakeouts.set(s, {
            mediaMap: mediaMap || {},
            globalMedia: globalMedia || {},
            convCache: convCache || {}
        });
    }

    function clearTakeoutData(slot?: string | null): void {
        if (slot) {
            __slotTakeouts.delete(normSlot(slot));
        } else {
            __slotTakeouts.clear();
        }
    }

export {
    extractC2PATimestamp,
    getTakeoutOfflineChat,
    getTakeoutMediaForChat,
    getTakeoutFallbackMedia,
    commitTakeoutData,
    clearTakeoutData,
    __slotTakeouts
};

export const MediaIndex: MediaIndexModule = {
    getStore,
    normId,
    extractC2PATimestamp,
    getTakeoutOfflineChat,
    getTakeoutMediaForChat,
    getTakeoutFallbackMedia,
    commitTakeoutData,
    clearTakeoutData,
    __slotTakeouts
};

export default MediaIndex;
