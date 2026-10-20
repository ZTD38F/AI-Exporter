import type { GeneratedMediaIdentity } from '../../types/conversation.js';
// Stable public facade for Takeout operations.
//
// Design intent — kept deliberately, this is not an empty shell:
// - This module is the SOLE public entry point for Takeout APIs. Nothing imports
//   ./takeout/mediaIndex.js or ./takeout/takeoutParser.js directly.
// - It aggregates two implementation modules (mediaIndex + takeoutParser) into one
//   coherent `TakeoutEngine` namespace, so consumers are insulated from internal
//   file moves.
// - The `TakeoutEngine` namespace object is the identity key of the
//   __resolveModule('TakeoutEngine', …) test seam (see takeoutController.ts,
//   optionsContext.ts, and tests using __setModuleOverride('TakeoutEngine', …)).
//   Deleting this facade would force the seam to be re-keyed and churn
//   2 production + 7 test files for zero behavioral gain.
import {
    getTakeoutOfflineChat,
    getTakeoutFallbackMedia,
    getTakeoutMediaForChat,
    extractC2PATimestamp,
    clearTakeoutData,
    getStore,
    __slotTakeouts,
    type TakeoutStore
} from "./takeout/mediaIndex.js";
import {
    parseTakeoutZip,
    type TakeoutParseResult
} from "./takeout/takeoutParser.js";

export type { TakeoutStore, TakeoutParseResult };

export interface TakeoutEngineModule {
    getTakeoutOfflineChat: (chatId: string, slot?: string | null) => any;
    getTakeoutFallbackMedia: (chatId: string, filenameOrId: string, slot?: string | null, generation?: GeneratedMediaIdentity) => Promise<Uint8Array | null>;
    getTakeoutMediaForChat: (chatId: string, slot?: string | null) => any[];
    extractC2PATimestamp: (bufferOrArray: any) => number | null;
    parseTakeoutZip: (file: any, onProgress?: ((pct: number, msg: string) => void) | null, slot?: string | null) => Promise<TakeoutParseResult>;
    clearTakeoutData: (slot?: string | null) => void;
    getStore: (slot?: string | null) => TakeoutStore;
    __slotTakeouts: Map<string, TakeoutStore>;
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

export default TakeoutEngine;
