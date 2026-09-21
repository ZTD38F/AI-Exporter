import GeminiProtocol, { GeminiProtocolModule, TOKEN_PATTERNS, TOKENS, BL_FALLBACK } from "../../protocol/protocol.js";

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
    resolveCred: (targetSid?: string | null, overrides?: { at?: string; bl?: string; } | null) => Promise<GeminiCredentials>;
    generateFallbackSid: () => string;
}

declare global {
    var GeminiClientCredentialManager: GeminiClientCredentialManagerModule;
}

function getProtocol(): GeminiProtocolModule {
    if (typeof globalThis !== "undefined" && (globalThis as any).GeminiProtocol) {
        return (globalThis as any).GeminiProtocol;
    }
    return GeminiProtocol;
}

    const generateFallbackSid = () => String(Math.floor(Math.random() * 1e19));

    let _blCache: { v: string | null; ts: number; len: number } | null = null;
    let _atCache: { v: string; ts: number; len: number } | null = null;
    const CRED_CACHE_TTL = 30000;

    // @contentScriptOnly — requires live page DOM, guarded for non-DOM environments
    function getBlFromPage(): string | null {
        if (typeof document === "undefined") return null;
        try {
            const glob = typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : {}) as any;
            const htmlLen = (glob.document && glob.document.documentElement && glob.document.documentElement.innerHTML || "").length;
            if (_blCache && Date.now() - _blCache.ts < CRED_CACHE_TTL && _blCache.len === htmlLen) return _blCache.v;
            const P = getProtocol();
            let html = (glob.document && glob.document.documentElement && glob.document.documentElement.innerHTML) || "";
            let m = html.match(P.TOKEN_PATTERNS.blCfb2hFromHtml) || html.match(P.TOKEN_PATTERNS.blAssistantFromHtml);
            let res: string | null = null;
            if (m) res = m[1];
            else if (glob.__gemExporterBl) res = glob.__gemExporterBl;
            _blCache = { v: res, ts: Date.now(), len: htmlLen };
            if (res) return res;
        } catch (e) { if (typeof console !== "undefined" && console.debug) console.debug("[GemExporter:credentialManager.ts]", e); }
        return null;
    }

    // @contentScriptOnly — requires live page DOM, guarded for non-DOM environments
    function getAtFromPage(): string {
        if (typeof document === "undefined") return "";
        try {
            const glob = typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : {}) as any;
            if (glob.__gemExporterExtractAt) {
                let a = glob.__gemExporterExtractAt();
                if (a) return a;
            }
            const htmlLen = (glob.document && glob.document.documentElement && glob.document.documentElement.innerHTML || "").length;
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
            let scripts = glob.document ? glob.document.querySelectorAll("script") : [];
            for (let s of scripts) {
                let txt = s.textContent || "";
                let m = txt.match(P.TOKEN_PATTERNS.atFromScript);
                if (m) {
                    _atCache = { v: m[1], ts: Date.now(), len: htmlLen };
                    return m[1];
                }
            }
            let html = (glob.document && glob.document.documentElement && glob.document.documentElement.innerHTML) || "";
            let mHtml = html.match(P.TOKEN_PATTERNS.atFromScript);
            if (mHtml) {
                _atCache = { v: mHtml[1], ts: Date.now(), len: htmlLen };
                return mHtml[1];
            }
        } catch (e) { if (typeof console !== "undefined" && console.debug) console.debug("[GemExporter:credentialManager.ts]", e); }
        return "";
    }

    // @contentScriptOnly — requires live page DOM, guarded for non-DOM environments
    function detectSlot(): string | null {
        if (typeof document === "undefined") return null;
        try {
            const glob = typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : {}) as any;
            let m = (glob.location && glob.location.pathname || "").match(/\/u\/(\d+)/);
            if (m) return `u${m[1]}`;
        } catch (e) { if (typeof console !== "undefined" && console.debug) console.debug("[GemExporter:credentialManager.ts]", e); }
        return "default";
    }

    function getCredStorage(): any {
        if (typeof chrome !== "undefined" && chrome.storage) {
            if (chrome.storage.session) return chrome.storage.session;
            return chrome.storage.local;
        }
        return null;
    }

    async function loadCredMap(): Promise<GeminiCredentialsMap> {
        const storage = getCredStorage();
        if (!storage) return {};
        try {
            let s: any = await storage.get(["gemini_credentials_map", "gemini_credentials"]);
            let map: GeminiCredentialsMap = s.gemini_credentials_map || {};
            if (s.gemini_credentials && s.gemini_credentials.sid && !map[s.gemini_credentials.sid]) {
                map[s.gemini_credentials.sid] = {
                    at: s.gemini_credentials.at || "",
                    bl: s.gemini_credentials.bl || getProtocol().BL_FALLBACK,
                    sid: s.gemini_credentials.sid,
                    accountSlot: "default",
                    lastUsed: Date.now()
                };
            }
            if (Object.keys(map).length === 0 && typeof chrome !== "undefined" && storage !== chrome.storage.local && chrome.storage.local) {
                try {
                    let localS: any = await chrome.storage.local.get(["gemini_credentials_map", "gemini_credentials"]);
                    let localMap: GeminiCredentialsMap = localS.gemini_credentials_map || {};
                    if (localS.gemini_credentials && localS.gemini_credentials.sid && !localMap[localS.gemini_credentials.sid]) {
                        localMap[localS.gemini_credentials.sid] = {
                            at: localS.gemini_credentials.at || "",
                            bl: localS.gemini_credentials.bl || getProtocol().BL_FALLBACK,
                            sid: localS.gemini_credentials.sid,
                            accountSlot: "default",
                            lastUsed: Date.now()
                        };
                    }
                    if (Object.keys(localMap).length > 0) {
                        map = localMap;
                        await storage.set({ gemini_credentials_map: map });
                        await chrome.storage.local.remove(["gemini_credentials_map", "gemini_credentials"]);
                    }
                } catch { /* intentional: migration fallback */ }
            }
            return map;
        } catch {
            return {};
        }
    }

    async function resolveCred(targetSid?: string | null, overrides?: { at?: string; bl?: string; } | null): Promise<GeminiCredentials> {
        let map = await loadCredMap();
        let vals = Object.values(map);
        let pageAt = getAtFromPage();
        let pageBl = getBlFromPage();
        if ((!vals.length || !vals[0].at) && pageAt) {
            let slot = detectSlot() || "default";
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
                    await storage.set({
                        gemini_credentials_map: {
                            [sid]: entry
                        },
                        gemini_credentials: {
                            at: pageAt,
                            sid
                        }
                    });
                    if (typeof chrome !== "undefined" && storage !== chrome.storage.local && chrome.storage.local) {
                        await chrome.storage.local.remove(["gemini_credentials_map", "gemini_credentials"]);
                    }
                }
            } catch (e) { if (typeof console !== "undefined" && console.debug) console.debug("[GemExporter:credentialManager.ts]", e); }
        } else if (pageBl && vals[0] && !vals[0].bl) {
            vals[0].bl = pageBl;
        }
        const normSlot = (s?: string | null) => (s === "u0" || !s ? "default" : s);
        let result: GeminiCredentials;
        if (targetSid && map[targetSid]) {
            result = {
                ...map[targetSid],
                bl: map[targetSid].bl || pageBl || getProtocol().BL_FALLBACK,
                at: map[targetSid].at || pageAt || ""
            };
        } else {
            let cur = normSlot(detectSlot());
            let f = vals.filter(v => normSlot(v.accountSlot) === cur);
            let arr = f.length ? f : vals;
            arr.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
            if (arr[0]) {
                result = {
                    ...arr[0],
                    bl: arr[0].bl || pageBl || getProtocol().BL_FALLBACK,
                    at: arr[0].at || pageAt || ""
                };
            } else {
                result = {
                    sid: generateFallbackSid(),
                    at: pageAt || "",
                    accountSlot: "default",
                    bl: pageBl || getProtocol().BL_FALLBACK
                };
            }
        }
        if (overrides) {
            if (overrides.at) result.at = overrides.at;
            if (overrides.bl) result.bl = overrides.bl;
        }
        return result;
    }

export {
    getBlFromPage,
    getAtFromPage,
    detectSlot,
    getCredStorage,
    loadCredMap,
    resolveCred,
    generateFallbackSid
};

export const GeminiClientCredentialManager: GeminiClientCredentialManagerModule = {
    getBlFromPage,
    getAtFromPage,
    detectSlot,
    getCredStorage,
    loadCredMap,
    resolveCred,
    generateFallbackSid
};

if (typeof globalThis !== "undefined" && !(globalThis as any).GeminiClientCredentialManager) {
    (globalThis as any).GeminiClientCredentialManager = GeminiClientCredentialManager;
}
if (typeof module === "object" && module.exports) {
    module.exports = GeminiClientCredentialManager;
}
export default GeminiClientCredentialManager;
