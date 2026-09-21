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
    getTakeoutFallbackMedia: (chatId: string, filenameOrId: string, slot?: string | null) => Promise<Uint8Array | null>;
    commitTakeoutData: (slot: string | null | undefined, data: TakeoutStore) => void;
    clearTakeoutData: (slot?: string | null) => void;
    __slotTakeouts: Map<string, TakeoutStore>;
}

declare global {
    var MediaIndex: MediaIndexModule;
}

const __slotTakeouts = new Map<string, TakeoutStore>();
let __takeoutMediaMap: Record<string, any> = {};
let __takeoutGlobalMedia: Record<string, any> = {};
let __takeoutConvCache: Record<string, any> = {};

export function getStore(slot?: string | null): TakeoutStore {
    if (slot && __slotTakeouts.has(slot)) {
        return __slotTakeouts.get(slot)!;
    }
    return {
        mediaMap: __takeoutMediaMap,
        globalMedia: __takeoutGlobalMedia,
        convCache: __takeoutConvCache
    };
}

export function normId(id?: string | null): string {
    try {
        if (typeof globalThis !== "undefined" && (globalThis as any).GeminiUtils?.normId) {
            return (globalThis as any).GeminiUtils.normId(id);
        }
        return utilsNormId(id);
    } catch {
        if (!id) return "";
        return String(id).replace(/^c_/, "").trim();
    }
}

    function extractC2PATimestamp(bufferOrArray: any): number | null {
        if (!bufferOrArray) return null;
        let str = '';
        if (typeof Buffer !== 'undefined' && Buffer.isBuffer(bufferOrArray)) {
            str = bufferOrArray.toString('binary');
        } else if (bufferOrArray instanceof Uint8Array || ArrayBuffer.isView(bufferOrArray)) {
            const byteLen = (bufferOrArray as any).byteLength ?? (bufferOrArray as any).length ?? 0;
            const len = Math.min(byteLen, 65536);
            const view = new Uint8Array((bufferOrArray as any).buffer || bufferOrArray, (bufferOrArray as any).byteOffset || 0, len);
            let s = '';
            for (let i = 0; i < len; i++) {
                s += String.fromCharCode(view[i]);
            }
            str = s;
        } else if (typeof bufferOrArray === 'string') {
            str = bufferOrArray;
        }
        const m = str.match(/(20\d{2}[01]\d[0-3]\d[0-2]\d[0-5]\d[0-5]\dZ)/);
        if (!m) return null;
        const s = m[1];
        const year = parseInt(s.slice(0, 4), 10);
        const month = parseInt(s.slice(4, 6), 10);
        const day = parseInt(s.slice(6, 8), 10);
        const hour = parseInt(s.slice(8, 10), 10);
        const min = parseInt(s.slice(10, 12), 10);
        const sec = parseInt(s.slice(12, 14), 10);
        return Date.UTC(year, month - 1, day, hour, min, sec);
    }

    function getTakeoutOfflineChat(chatId: string, slot?: string | null): any {
        if (!chatId) return null;
        const nid = normId(chatId);
        const store = getStore(slot);
        return store.convCache[nid] || __takeoutConvCache[nid] || null;
    }

    function getTakeoutMediaForChat(chatId: string, slot?: string | null): any[] {
        if (!chatId) return [];
        const nid = normId(chatId);
        const store = getStore(slot);
        return (store.mediaMap && store.mediaMap[nid]) || __takeoutMediaMap[nid] || [];
    }

    async function getTakeoutFallbackMedia(chatId: string, filenameOrId: string, slot?: string | null): Promise<Uint8Array | null> {
        if (!filenameOrId) return null;
        const nid = normId(chatId);
        const store = getStore(slot);
        const mediaMap = store.mediaMap || __takeoutMediaMap;
        const globalMedia = store.globalMedia || __takeoutGlobalMedia;
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
            // Pass 1: Exact match pass across all items in conversation media
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

            // Pass 2: Fuzzy stem matching (ONLY for distinctive non-generic names)
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
                    if (cleanItemStem === cleanTargetStem || cleanItemStem === targetStem || itemStem === cleanTargetStem ||
                        (cleanItemStem.length > 3 && cleanTargetStem.includes(cleanItemStem)) ||
                        (cleanTargetStem.length > 3 && cleanItemStem.includes(cleanTargetStem))) {
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
                    (cleanStem === cleanTargetStem || stem === targetStem ||
                    (cleanStem.length > 4 && (cleanStem.includes(cleanTargetStem) || cleanTargetStem.includes(cleanStem))))) {
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
        __takeoutMediaMap = mediaMap;
        __takeoutGlobalMedia = globalMedia;
        __takeoutConvCache = convCache;
        if (slot) {
            __slotTakeouts.set(slot, {
                mediaMap,
                globalMedia,
                convCache
            });
        }
    }

    function clearTakeoutData(slot?: string | null): void {
        if (slot && __slotTakeouts.has(slot)) {
            const slotData = __slotTakeouts.get(slot);
            if (slotData) {
                if (__takeoutMediaMap === slotData.mediaMap) __takeoutMediaMap = {};
                if (__takeoutGlobalMedia === slotData.globalMedia) __takeoutGlobalMedia = {};
                if (__takeoutConvCache === slotData.convCache) __takeoutConvCache = {};
            }
            __slotTakeouts.delete(slot);
        } else {
            __slotTakeouts.clear();
            __takeoutMediaMap = {};
            __takeoutGlobalMedia = {};
            __takeoutConvCache = {};
        }
        if (__slotTakeouts.size === 0) {
            __takeoutMediaMap = {};
            __takeoutGlobalMedia = {};
            __takeoutConvCache = {};
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

(MediaIndex as any).MediaIndex = MediaIndex;
(MediaIndex as any).default = MediaIndex;

if (typeof globalThis !== 'undefined' && !(globalThis as any).MediaIndex) {
    (globalThis as any).MediaIndex = MediaIndex;
}
if (typeof module === 'object' && module.exports) {
    module.exports = MediaIndex;
}
export default MediaIndex;
