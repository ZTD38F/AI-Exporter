// src/core/engine/takeoutEngine.ts - Re-export facade for Takeout operations
import MediaIndex, {
    getTakeoutOfflineChat,
    getTakeoutFallbackMedia,
    getTakeoutMediaForChat,
    extractC2PATimestamp,
    clearTakeoutData,
    getStore,
    __slotTakeouts,
    type MediaIndexModule,
    type TakeoutStore
} from "./takeout/mediaIndex.js";
import TakeoutParser, {
    parseTakeoutZip,
    type TakeoutParserModule,
    type TakeoutParseResult
} from "./takeout/takeoutParser.js";

export type { TakeoutStore, TakeoutParseResult };

export interface TakeoutEngineModule {
    getTakeoutOfflineChat: (chatId: string, slot?: string | null) => any;
    getTakeoutFallbackMedia: (chatId: string, filenameOrId: string, slot?: string | null) => Promise<Uint8Array | null>;
    getTakeoutMediaForChat: (chatId: string, slot?: string | null) => any[];
    extractC2PATimestamp: (bufferOrArray: any) => number | null;
    parseTakeoutZip: (file: any, onProgress?: ((pct: number, msg: string) => void) | null, slot?: string | null) => Promise<TakeoutParseResult>;
    clearTakeoutData: (slot?: string | null) => void;
    getStore: (slot?: string | null) => TakeoutStore;
    __slotTakeouts: Map<string, TakeoutStore>;
}

declare global {
    var TakeoutEngine: TakeoutEngineModule;
}

export {
    getTakeoutOfflineChat,
    getTakeoutFallbackMedia,
    getTakeoutMediaForChat,
    extractC2PATimestamp,
    parseTakeoutZip,
    clearTakeoutData,
    getStore,
    __slotTakeouts
};

export const TakeoutEngine: TakeoutEngineModule = {
    getTakeoutOfflineChat,
    getTakeoutFallbackMedia,
    getTakeoutMediaForChat,
    extractC2PATimestamp,
    parseTakeoutZip,
    clearTakeoutData,
    getStore,
    __slotTakeouts
};

(TakeoutEngine as any).TakeoutEngine = TakeoutEngine;
(TakeoutEngine as any).default = TakeoutEngine;

if (typeof globalThis !== 'undefined' && !(globalThis as any).TakeoutEngine) {
    (globalThis as any).TakeoutEngine = TakeoutEngine;
}
if (typeof module === 'object' && module.exports) {
    module.exports = TakeoutEngine;
}
export default TakeoutEngine;
