import GeminiProtocol from "../../../protocol/gemini/protocol.js";
import { detectSlotFromUrl } from "../../../../shared/utils/pathUtils.js";
import { STORAGE_KEYS } from "../../../../shared/utils/constants.js";
import { getCredStorage, withCredMapLock } from "./credStorage.js";

export interface GeminiCredentials {
    sid?: string | number | null;
    at: string;
    bl: string;
    accountSlot?: string | null;
    lastUsed?: number | string | null;
}

// Persisted entries may be partial or malformed. Keep them intact on writeback.
type RawCredentialMap = Record<string, unknown>;
interface StoredCredential {
    sid?: string | number | null;
    at?: string | null;
    bl?: string | null;
    accountSlot?: string | null;
    lastUsed?: number | string | null;
}
function normalizedCredentialSlot(slot?: string | null): string | null {
    if (!slot || slot === 'default') return 'default';
    const match = /^(?:u|\/?u\/)(\d+)$/i.exec(slot);
    if (!match) return null;
    return /^0+$/.test(match[1]) ? 'default' : `u${match[1]}`;
}

function isStoredCredential(value: unknown): value is StoredCredential {
    if (!isRecord(value)) return false;
    const lastUsed = value.lastUsed;
    const sortableLastUsed = typeof lastUsed === 'string' && lastUsed.trim() ? Number(lastUsed) : lastUsed;
    return (value.sid === undefined || value.sid === null || typeof value.sid === 'string'
            || typeof value.sid === 'number' && Number.isFinite(value.sid) && Number.isInteger(value.sid) && value.sid > 0)
        && (value.at === undefined || value.at === null || typeof value.at === 'string')
        && (value.bl === undefined || value.bl === null || typeof value.bl === 'string')
        && (value.accountSlot === undefined || value.accountSlot === null
            || typeof value.accountSlot === 'string' && normalizedCredentialSlot(value.accountSlot) !== null)
        && (lastUsed === undefined || lastUsed === null
            || typeof sortableLastUsed === 'number'
                && Number.isSafeInteger(sortableLastUsed) && sortableLastUsed >= 0);
}

export interface GeminiClientCredentialManagerModule {
    getBlFromPage: () => string | null;
    getAtFromPage: () => string;
    detectSlot: (urlOrPath?: string | null) => string | null;
    updateCredential: (sid: string | number, decide: () => { patch: { at?: string; bl?: string } | null; clearLocal?: boolean }) => Promise<void>;
    resolveCred: (targetSidOrSlot?: string | null, overrides?: { at?: string; bl?: string | null; accountSlot?: string } | null) => Promise<GeminiCredentials>;
    generateFallbackSid: () => string;
}

const generateFallbackSid = (): string => String(Math.floor(Math.random() * 1e19));

let _blCache: { v: string | null; ts: number; len: number } | null = null;
let _atCache: { v: string; ts: number; len: number } | null = null;
const CRED_CACHE_TTL = 30000;

function isRecord(val: unknown): val is Record<string, unknown> {
    return typeof val === "object" && val !== null && !Array.isArray(val);
}

function getBlFromPage(): string | null {
    try {
        if (typeof document === "undefined") return null;
        const html = document.documentElement?.innerHTML ?? "";
        const htmlLen = html.length;
        if (_blCache && Date.now() - _blCache.ts < CRED_CACHE_TTL && _blCache.len === htmlLen) {
            return _blCache.v;
        }
        const P = GeminiProtocol;
        const m = html.match(P.TOKEN_PATTERNS.blCfb2hFromHtml) || html.match(P.TOKEN_PATTERNS.blAssistantFromHtml);
        const res = m?.[1] ?? null;
        _blCache = { v: res, ts: Date.now(), len: htmlLen };
        if (res) return res;
    } catch (e) {
        console.debug("[GemExporter:credentialManager.ts]", e);
    }
    return null;
}

function getAtFromPage(): string {
    try {
        const glob = globalThis;
        const extractAtFn = glob.__gemExporterExtractAt;
        if (extractAtFn) {
            const at = extractAtFn();
            if (at) return at;
        }
        if (typeof document === "undefined") return "";
        const html = document.documentElement?.innerHTML ?? "";
        const htmlLen = html.length;
        if (_atCache && Date.now() - _atCache.ts < CRED_CACHE_TTL && _atCache.len === htmlLen) {
            return _atCache.v;
        }
        const P = GeminiProtocol;
        if (isRecord(glob._WIZ_global_data)) {
            const v = glob._WIZ_global_data[P.TOKENS.AT];
            if (typeof v === "string" && v) {
                _atCache = { v, ts: Date.now(), len: htmlLen };
                return v;
            }
        }
        if (isRecord(glob.WIZ_global_data)) {
            const v = glob.WIZ_global_data[P.TOKENS.AT];
            if (typeof v === "string" && v) {
                _atCache = { v, ts: Date.now(), len: htmlLen };
                return v;
            }
        }
        for (const script of document.querySelectorAll("script")) {
            const text = script.textContent;
            if (!text) continue;
            const m = text.match(P.TOKEN_PATTERNS.atFromScript);
            if (m) {
                _atCache = { v: m[1], ts: Date.now(), len: htmlLen };
                return m[1];
            }
        }
        const mHtml = html.match(P.TOKEN_PATTERNS.atFromScript);
        if (mHtml) {
            _atCache = { v: mHtml[1], ts: Date.now(), len: htmlLen };
            return mHtml[1];
        }
    } catch (e) {
        console.debug("[GemExporter:credentialManager.ts]", e);
    }
    return "";
}

function detectSlot(urlOrPath?: string | null): string | null {
    try {
        let path = urlOrPath ?? "";
        if (!path) {
            path = globalThis.location?.pathname ?? "";
        }
        const slot = detectSlotFromUrl(path);
        return slot === "u0" ? "default" : slot;
    } catch (e) {
        console.debug("[GemExporter:credentialManager.ts]", e);
    }
    return "default";
}

async function loadRawCredMap(): Promise<RawCredentialMap> {
    const storage = getCredStorage();
    if (!storage) return {};
    try {
        const result: unknown = await storage.get([STORAGE_KEYS.CREDENTIALS_MAP]);
        const raw = isRecord(result) ? result[STORAGE_KEYS.CREDENTIALS_MAP] : undefined;
        return isRecord(raw) ? raw : {};
    } catch {
        return {};
    }
}

// Keep the untouched storage snapshot only for writeback; selection sees validated entries.
async function loadCredMap() {
    const raw = await loadRawCredMap();
    const entries = new Map<string, StoredCredential>();
    for (const [sid, value] of Object.entries(raw)) {
        if (isStoredCredential(value)) entries.set(sid, value);
    }
    return { raw, entries };
}

async function updateCredential(
    sid: string | number,
    decide: Parameters<GeminiClientCredentialManagerModule['updateCredential']>[1]
): Promise<void> {
    await withCredMapLock(async () => {
        const { patch, clearLocal = true } = decide();
        const map = await loadRawCredMap();
        const key = String(sid);
        if (!Object.hasOwn(map, key)) return;
        const entry = map[key];
        if (patch === null) {
            if (!entry) return;
            delete map[key];
        } else {
            if (!isRecord(entry)) return;
            map[key] = { ...entry, ...patch };
        }
        const storage = getCredStorage();
        if (!storage) return;
        const localStorage = chrome.storage?.local;
        await storage.set({ [STORAGE_KEYS.CREDENTIALS_MAP]: map });
        if (clearLocal && localStorage && storage !== localStorage) {
            await localStorage.remove([STORAGE_KEYS.CREDENTIALS_MAP, STORAGE_KEYS.CREDENTIALS]);
        }
    });
}

async function resolveCred(
    targetSidOrSlot?: string | null,
    overrides?: { at?: string; bl?: string | null; accountSlot?: string } | null
): Promise<GeminiCredentials> {
    return withCredMapLock(() => resolveCredInner(targetSidOrSlot, overrides));
}

async function resolveCredInner(
    targetSidOrSlot?: string | null,
    overrides?: { at?: string; bl?: string | null; accountSlot?: string } | null
): Promise<GeminiCredentials> {
    if (targetSidOrSlot?.includes('@')) throw new TypeError('Email is not a credential routing identity');
    const { raw: map, entries } = await loadCredMap();
    let vals = [...entries.values()];
    const pageBl = getBlFromPage();
    const normSlot = (slot?: string | null) => normalizedCredentialSlot(slot) ?? slot ?? 'default';
    const isSlotParam = targetSidOrSlot && (
        /^u\d+$/i.test(targetSidOrSlot) ||
        targetSidOrSlot === 'default'
    );
    const targetSid = !isSlotParam && targetSidOrSlot ? targetSidOrSlot : null;
    const requestedSlot = overrides?.accountSlot || (isSlotParam ? targetSidOrSlot : null);
    const stored = targetSid ? entries.get(targetSid) : undefined;
    const pageSlot = normSlot(detectSlot());
    const selectionSlot = normSlot(requestedSlot || stored?.accountSlot || pageSlot);
    const pageAt = selectionSlot === pageSlot
        && (!stored || !!stored.accountSlot && normSlot(stored.accountSlot) === pageSlot)
        ? getAtFromPage() : '';

    const slotEntries = [...entries].filter(([, value]) => normSlot(value.accountSlot) === selectionSlot);
    const partial = slotEntries.find(([, value]) => !!value.accountSlot && !value.at && !!value.sid);
    if (pageAt && !slotEntries.some(([, value]) => value.at)) {
        const key = partial?.[0] ?? ('page_' + Date.now());
        const sid = partial?.[1].sid || key;
        const entry: GeminiCredentials = {
            ...partial?.[1],
            sid,
            at: pageAt,
            bl: partial?.[1].bl || pageBl || GeminiProtocol.BL_FALLBACK,
            accountSlot: selectionSlot,
            lastUsed: Date.now()
        };
        vals = [entry];
        try {
            const storage = getCredStorage();
            if (storage) {
                const localStorage = chrome.storage?.local;
                map[key] = entry;
                entries.set(key, entry);
                await storage.set({
                    [STORAGE_KEYS.CREDENTIALS_MAP]: map,
                    [STORAGE_KEYS.CREDENTIALS]: {
                        at: pageAt,
                        sid
                    }
                });
                if (localStorage && storage !== localStorage) {
                    await localStorage.remove([STORAGE_KEYS.CREDENTIALS_MAP, STORAGE_KEYS.CREDENTIALS]);
                }
            }
        } catch (e) {
            console.debug("[GemExporter:credentialManager.ts]", e);
        }
    } else if (pageBl) {
        const curSlot = selectionSlot;
        const target = vals.find(v => !v.bl && normSlot(v.accountSlot) === curSlot);
        if (target) {
            target.bl = pageBl;
            try {
                const storage = getCredStorage();
                if (storage) await storage.set({ [STORAGE_KEYS.CREDENTIALS_MAP]: map });
            } catch { /* keep in-memory copy; retried on next resolveCred */ }
        }
    }

    let result: GeminiCredentials;
    if (stored) {
        result = {
            ...stored,
            ...(stored.accountSlot ? { accountSlot: normSlot(stored.accountSlot) } : {}),
            bl: stored.bl || pageBl || GeminiProtocol.BL_FALLBACK,
            at: stored.at || pageAt || ""
        };
    } else {
        const cur = selectionSlot;
        const f = vals.filter(v => normSlot(v.accountSlot) === cur);
        // CRITICAL SECURITY FIX: Do NOT fall back to `vals` when `f` is empty!
        // Borrowing other accounts' credentials causes silent cross-account token pollution.
        f.sort((a, b) => (Number(b.lastUsed) || 0) - (Number(a.lastUsed) || 0));
        if (f[0]) {
            const best = f[0];
            result = {
                ...best,
                ...(best.accountSlot ? { accountSlot: normSlot(best.accountSlot) } : {}),
                bl: best.bl || pageBl || GeminiProtocol.BL_FALLBACK,
                at: best.at || (cur === pageSlot ? pageAt : "") || ""
            };
        } else {
            const isCurrentPageMatch = cur === normSlot(detectSlot());
            result = {
                sid: generateFallbackSid(),
                at: isCurrentPageMatch ? (pageAt || "") : "",
                accountSlot: cur,
                bl: pageBl || GeminiProtocol.BL_FALLBACK
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

export { getBlFromPage, getAtFromPage, detectSlot, updateCredential, resolveCred, generateFallbackSid };

export const GeminiClientCredentialManager: GeminiClientCredentialManagerModule = {
    getBlFromPage,
    getAtFromPage,
    detectSlot,
    updateCredential,
    resolveCred,
    generateFallbackSid
};

export default GeminiClientCredentialManager;
