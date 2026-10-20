import GeminiProtocol, { GeminiProtocolModule } from "../../protocol/protocol.js";
import { detectSlotFromUrl } from "../../utils/pathUtils.js";
import { STORAGE_KEYS } from "../../utils/constants.js";
import { __resolveModule } from "../../utils/moduleOverrides.js";
import { getCredStorage, withCredMapLock } from "./credStorage.js";

export interface GeminiCredentials {
    sid: string;
    at: string;
    bl: string;
    accountSlot: string;
    lastUsed?: number;
}

export type GeminiCredentialsMap = Record<string, GeminiCredentials>;

export interface GeminiClientCredentialManagerModule {
    getBlFromPage: () => string | null;
    getAtFromPage: () => string;
    detectSlot: () => string | null;
    getCredStorage: () => any;
    loadCredMap: () => Promise<GeminiCredentialsMap>;
    migrateCredentials: () => Promise<boolean>;
    resolveCred: (targetSidOrSlot?: string | null, overrides?: { at?: string; bl?: string; accountSlot?: string } | null) => Promise<GeminiCredentials>;
    generateFallbackSid: () => string;
}

function getProtocol(): GeminiProtocolModule {
    return __resolveModule('GeminiProtocol', GeminiProtocol);
}

    const generateFallbackSid = () => String(Math.floor(Math.random() * 1e19));

    let _blCache: { v: string | null; ts: number; len: number } | null = null;
    let _atCache: { v: string; ts: number; len: number } | null = null;
    const CRED_CACHE_TTL = 30000;

    function getBlFromPage(doc?: any): string | null {
        try {
            const glob = typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : {}) as any;
            const targetDoc = doc || glob.document;
            if (!targetDoc) return null;
            const htmlLen = (targetDoc.documentElement && targetDoc.documentElement.innerHTML || "").length;
            if (_blCache && Date.now() - _blCache.ts < CRED_CACHE_TTL && _blCache.len === htmlLen) return _blCache.v;
            const P = getProtocol();
            let html = (targetDoc.documentElement && targetDoc.documentElement.innerHTML) || "";
            let m = html.match(P.TOKEN_PATTERNS.blCfb2hFromHtml) || html.match(P.TOKEN_PATTERNS.blAssistantFromHtml);
            let res: string | null = null;
            if (m) res = m[1];
            else if (glob.__gemExporterBl) res = glob.__gemExporterBl;
            _blCache = { v: res, ts: Date.now(), len: htmlLen };
            if (res) return res;
        } catch (e) { if (typeof console !== "undefined" && console.debug) console.debug("[GemExporter:credentialManager.ts]", e); }
        return null;
    }

    function getAtFromPage(doc?: any): string {
        try {
            const glob = typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : {}) as any;
            if (glob.__gemExporterExtractAt) {
                let a = glob.__gemExporterExtractAt();
                if (a) return a;
            }
            const targetDoc = doc || glob.document;
            if (!targetDoc) return "";
            const htmlLen = (targetDoc.documentElement && targetDoc.documentElement.innerHTML || "").length;
            if (_atCache && Date.now() - _atCache.ts < CRED_CACHE_TTL && _atCache.len === htmlLen) return _atCache.v;
            const P = getProtocol();
            if (glob._WIZ_global_data && glob._WIZ_global_data[P.TOKENS.AT]) {
                const v = glob._WIZ_global_data[P.TOKENS.AT];
                _atCache = { v, ts: Date.now(), len: htmlLen };
                return v;
            }
            if (glob.WIZ_global_data && glob.WIZ_global_data[P.TOKENS.AT]) {
                const v = glob.WIZ_global_data[P.TOKENS.AT];
                _atCache = { v, ts: Date.now(), len: htmlLen };
                return v;
            }
            let scripts = targetDoc.querySelectorAll ? targetDoc.querySelectorAll("script") : [];
            for (let s of scripts) {
                let txt = s.textContent || "";
                let m = txt.match(P.TOKEN_PATTERNS.atFromScript);
                if (m) {
                    _atCache = { v: m[1], ts: Date.now(), len: htmlLen };
                    return m[1];
                }
            }
            let html = (targetDoc.documentElement && targetDoc.documentElement.innerHTML) || "";
            let mHtml = html.match(P.TOKEN_PATTERNS.atFromScript);
            if (mHtml) {
                _atCache = { v: mHtml[1], ts: Date.now(), len: htmlLen };
                return mHtml[1];
            }
        } catch (e) { if (typeof console !== "undefined" && console.debug) console.debug("[GemExporter:credentialManager.ts]", e); }
        return "";
    }

    function detectSlot(urlOrPath?: string): string | null {
        try {
            const glob = typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : {}) as any;
            const path = urlOrPath || (glob.location && glob.location.pathname) || "";
            const slot = detectSlotFromUrl(path);
            return slot === "u0" ? "default" : slot;
        } catch (e) { if (typeof console !== "undefined" && console.debug) console.debug("[GemExporter:credentialManager.ts]", e); }
        return "default";
    }


    function normalizeLegacySingleCred(s: any, map: GeminiCredentialsMap): void {
        const legacy = s?.[STORAGE_KEYS.CREDENTIALS];
        if (legacy?.sid && !map[legacy.sid]) {
            map[legacy.sid] = {
                at: legacy.at || "",
                bl: legacy.bl || getProtocol().BL_FALLBACK,
                sid: legacy.sid,
                accountSlot: "default",
                lastUsed: Date.now()
            };
        }
    }

    async function loadCredMap(): Promise<GeminiCredentialsMap> {
        const storage = getCredStorage();
        if (!storage) return {};
        try {
            const s: any = await storage.get([STORAGE_KEYS.CREDENTIALS_MAP]);
            return (s && s[STORAGE_KEYS.CREDENTIALS_MAP]) || {};
        } catch {
            return {};
        }
    }

    let _resolveChain: Promise<any> = Promise.resolve();
    function runSerializedResolve<T>(op: () => Promise<T>): Promise<T> {
        const run = _resolveChain.then(op, op);
        _resolveChain = run.then(() => undefined, () => undefined);
        return run;
    }

    async function resolveCred(
        targetSidOrSlot?: string | null,
        overrides?: { at?: string; bl?: string; accountSlot?: string } | null
    ): Promise<GeminiCredentials> {
        return runSerializedResolve(() => withCredMapLock(() => resolveCredInner(targetSidOrSlot, overrides)));
    }

    async function resolveCredInner(
        targetSidOrSlot?: string | null,
        overrides?: { at?: string; bl?: string; accountSlot?: string } | null
    ): Promise<GeminiCredentials> {
        let map = await loadCredMap();
        let vals = Object.values(map);
        let pageAt = getAtFromPage();
        let pageBl = getBlFromPage();

        const normSlot = (s?: string | null) => (s === "u0" || !s ? "default" : s);

        const isSlotParam = targetSidOrSlot && (
            /^u\d+$/i.test(targetSidOrSlot) ||
            targetSidOrSlot.includes('@') ||
            targetSidOrSlot === 'default'
        );
        const targetSid = (!isSlotParam && targetSidOrSlot && map[targetSidOrSlot]) ? targetSidOrSlot : null;
        const requestedSlot = overrides?.accountSlot || (isSlotParam ? targetSidOrSlot : null);

        if ((!vals.length || !vals[0].at) && pageAt) {
            let slot = requestedSlot || detectSlot() || "default";
            let sid = vals[0]?.sid || ("page_" + Date.now());
            let entry: GeminiCredentials = {
                sid,
                at: pageAt,
                bl: pageBl || getProtocol().BL_FALLBACK,
                accountSlot: slot,
                lastUsed: Date.now()
            };
            vals = [entry];
            try {
                const storage = getCredStorage();
                if (storage) {
                    map[sid] = entry;
                    await storage.set({
                        [STORAGE_KEYS.CREDENTIALS_MAP]: map,
                        [STORAGE_KEYS.CREDENTIALS]: {
                            at: pageAt,
                            sid
                        }
                    });
                    if (typeof chrome !== "undefined" && storage !== chrome.storage.local && chrome.storage.local) {
                        await chrome.storage.local.remove([STORAGE_KEYS.CREDENTIALS_MAP, STORAGE_KEYS.CREDENTIALS]);
                    }
                }
            } catch (e) { if (typeof console !== "undefined" && console.debug) console.debug("[GemExporter:credentialManager.ts]", e); }
        } else if (pageBl) {
            const curSlot = normSlot(requestedSlot || detectSlot());
            const target = vals.find(v => !v.bl && normSlot(v.accountSlot) === curSlot);
            if (target) {
                target.bl = pageBl;
                try {
                    const storage = getCredStorage();
                    if (storage) await storage.set({ gemini_credentials_map: map });
                } catch (e) { /* keep in-memory copy; retried on next resolveCred */ }
            }
        }

        let result: GeminiCredentials;
        if (targetSid && map[targetSid]) {
            result = {
                ...map[targetSid],
                bl: map[targetSid].bl || pageBl || getProtocol().BL_FALLBACK,
                at: map[targetSid].at || pageAt || ""
            };
        } else {
            let cur = normSlot(requestedSlot || detectSlot());
            let f = vals.filter(v => normSlot(v.accountSlot) === cur);
            // CRITICAL SECURITY FIX: Do NOT fall back to `vals` when `f` is empty!
            // Borrowing other accounts' credentials causes silent cross-account token pollution.
            let arr = f;
            arr.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
            if (arr[0]) {
                result = {
                    ...arr[0],
                    bl: arr[0].bl || pageBl || getProtocol().BL_FALLBACK,
                    at: arr[0].at || (cur === normSlot(detectSlot()) ? pageAt : "") || ""
                };
            } else {
                const isCurrentPageMatch = cur === normSlot(detectSlot());
                result = {
                    sid: generateFallbackSid(),
                    at: isCurrentPageMatch ? (pageAt || "") : "",
                    accountSlot: cur,
                    bl: pageBl || getProtocol().BL_FALLBACK
                };
            }
        }
        if (overrides) {
            if (overrides.at) result.at = overrides.at;
            if (overrides.bl) result.bl = overrides.bl;
            if (overrides.accountSlot) result.accountSlot = overrides.accountSlot;
        }
        return result;
    }

    async function migrateCredentials(): Promise<boolean> {
        return withCredMapLock(async () => {
            const storage = getCredStorage();
            if (!storage) return false;
            let migrated = false;
            try {
                const s: any = await storage.get([STORAGE_KEYS.CREDENTIALS_MAP, STORAGE_KEYS.CREDENTIALS]);
                const map: GeminiCredentialsMap = s[STORAGE_KEYS.CREDENTIALS_MAP] || {};
                const before = Object.keys(map).length;
                normalizeLegacySingleCred(s, map);
                if (Object.keys(map).length !== before) migrated = true;
                if (typeof chrome !== "undefined" && storage !== chrome.storage.local && chrome.storage.local) {
                    try {
                        const localS: any = await chrome.storage.local.get([STORAGE_KEYS.CREDENTIALS_MAP, STORAGE_KEYS.CREDENTIALS]);
                        const localMap: GeminiCredentialsMap = localS[STORAGE_KEYS.CREDENTIALS_MAP] || {};
                        normalizeLegacySingleCred(localS, localMap);
                        let merged = false;
                        for (const [k, v] of Object.entries(localMap)) {
                            if (!map[k]) { map[k] = v; merged = true; }
                        }
                        if (merged) {
                            migrated = true;
                            await chrome.storage.local.remove([STORAGE_KEYS.CREDENTIALS_MAP, STORAGE_KEYS.CREDENTIALS]);
                        }
                    } catch { /* intentional: migration fallback */ }
                }
                if (migrated) {
                    await storage.set({ [STORAGE_KEYS.CREDENTIALS_MAP]: map });
                }
                if (s?.[STORAGE_KEYS.CREDENTIALS] && typeof storage.remove === 'function') {
                    await storage.remove([STORAGE_KEYS.CREDENTIALS]);
                }
            } catch { /* migration best-effort */ }
            return migrated;
        });
    }

export {
    getBlFromPage,
    getAtFromPage,
    detectSlot,
    getCredStorage,
    loadCredMap,
    migrateCredentials,
    resolveCred,
    generateFallbackSid
};

export const GeminiClientCredentialManager: GeminiClientCredentialManagerModule = {
    getBlFromPage,
    getAtFromPage,
    detectSlot,
    getCredStorage,
    loadCredMap,
    migrateCredentials,
    resolveCred,
    generateFallbackSid
};

export default GeminiClientCredentialManager;
