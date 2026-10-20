import { CrossWorldEvents, GeminiProtocol, type GeminiProtocolModule } from '../core/protocol/protocol.js';
import type { GeminiCredentialsPayload } from '../core/protocol/events.js';
import { STORAGE_KEYS } from '../core/utils/constants.js';
import {
    getCredStorage as sharedGetCredStorage,
    markCredSessionAccessFailed as sharedMarkFailed,
    withCredMapLock,
} from '../core/api/client/credStorage.js';
import { sniffUserProfileFromDom } from './accountSniffer.js';
import { StorageService } from '../core/storage/storageService.js';

export function getCredStorage(): chrome.storage.StorageArea | null {
    return sharedGetCredStorage();
}

function markCredSessionFailed(): void {
    sharedMarkFailed();
}

const SK_CRED_MAP = STORAGE_KEYS.CREDENTIALS_MAP;
const SK_CRED = STORAGE_KEYS.CREDENTIALS;

const Proto: GeminiProtocolModule = GeminiProtocol as any;

function isDev(): boolean {
    if (typeof window !== 'undefined') {
        const ctx = (window as any).__gemExporterContentContext;
        if (ctx && typeof ctx.isDevMode === 'function') return ctx.isDevMode();
        return !!(window as any).__gemExporterDevMode;
    }
    return false;
}

function updateContextCreds(creds: Record<string, any>): void {
    if (typeof window !== 'undefined') {
        const ctx = (window as any).__gemExporterContentContext;
        if (ctx && typeof ctx.setCredentials === 'function') {
            ctx.setCredentials(creds);
        }
    }
}

export function extractAtFromPage(): string {
    if (!Proto) return '';
    try {
        try {
            if (typeof window !== 'undefined') {
                const w = window as any;
                if (w.__gemExporterExtractedAt && typeof w.__gemExporterExtractedAt === 'string' && w.__gemExporterExtractedAt.length > 15) {
                    return w.__gemExporterExtractedAt;
                }
                if (w.__geminiAt && typeof w.__geminiAt === 'string' && w.__geminiAt.length > 15) {
                    return w.__geminiAt;
                }
            }
        } catch (e) {
            if (isDev()) console.debug('[GemExporter:bootstrap.ts]', e);
        }

        try {
            const w = (typeof window !== 'undefined' ? window : globalThis) as any;
            if (w._WIZ_global_data?.[Proto.TOKENS.AT]) return w._WIZ_global_data[Proto.TOKENS.AT];
            if (w.WIZ_global_data?.[Proto.TOKENS.AT]) return w.WIZ_global_data[Proto.TOKENS.AT];
            if (w.__WIZ_global_data?.[Proto.TOKENS.AT]) return w.__WIZ_global_data[Proto.TOKENS.AT];
        } catch (e) {
            if (isDev()) console.debug('[GemExporter:bootstrap.ts]', e);
        }

        if (typeof document !== 'undefined') {
            const scripts = document.querySelectorAll('script');
            for (const s of Array.from(scripts)) {
                const txt = s.textContent || '';
                if (!txt) continue;
                const m = txt.match(Proto.TOKEN_PATTERNS.atFromScript);
                if (m && m[1].length > 10) return m[1];
                const m2 = txt.match(Proto.TOKEN_PATTERNS.atGenericFromScript);
                if (m2 && m2[1].length > 15 && !m2[1].includes('%') && !m2[1].includes('\\')) return m2[1];
                const m3 = txt.match(Proto.TOKEN_PATTERNS.blKeyFromScript);
                if (m3 && m3[1].startsWith('A') && m3[1].length > 15) return m3[1];
            }
        }

        try {
            if (typeof localStorage !== 'undefined' && typeof sessionStorage !== 'undefined') {
                const ls = localStorage.getItem(Proto.TOKENS.AT) || sessionStorage.getItem(Proto.TOKENS.AT);
                if (ls) return ls;
            }
        } catch (e) {
            if (isDev()) console.debug('[GemExporter:bootstrap.ts]', e);
        }
    } catch (e) {
        console.warn('extractAt fail', e);
    }
    return '';
}

export function extractBlFromPage(): string {
    if (!Proto) return '';
    try {
        if (typeof document !== 'undefined') {
            const scripts = document.querySelectorAll('script');
            for (const s of Array.from(scripts)) {
                const txt = s.textContent || '';
                if (!txt) continue;
                const m = txt.match(Proto.TOKEN_PATTERNS.blKeyFromScript);
                if (m && m[1] && m[1].startsWith('boq_')) return m[1];
                const m2 = txt.match(Proto.TOKEN_PATTERNS.boqBuildFromScript);
                if (m2) return m2[0];
            }
            const html = document.documentElement?.innerHTML || '';
            const m3 = html.match(Proto.TOKEN_PATTERNS.blValueFromHtml);
            if (m3) return m3[1];
        }
    } catch (e) {
        if (isDev()) console.debug('[GemExporter:bootstrap.ts]', e);
    }
    return '';
}

export function detectSlotFromUrl(url?: string): string {
    try {
        const u = new URL(url || (typeof location !== 'undefined' ? location.href : 'https://gemini.google.com/app'));
        const m = u.pathname.match(/\/u\/(\d+)(?:\/|$)/);
        if (m) return `u${m[1]}`;
    } catch (e) {
        if (isDev()) console.debug('[GemExporter:bootstrap.ts]', e);
    }
    return 'u0';
}

export function isExtAlive(): boolean {
    try {
        return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
    } catch {
        return false;
    }
}

export async function loadCredentialsMap(): Promise<Record<string, any>> {
    let storage = getCredStorage();
    if (!storage) return {};
    let mapObj: any = {};
    try {
        mapObj = await storage.get([SK_CRED_MAP]);
    } catch (e: any) {
        if (String(e?.message || e).includes('not allowed')) {
            markCredSessionFailed();
            storage = chrome.storage.local;
            if (storage) {
                mapObj = await storage.get([SK_CRED_MAP]);
            }
        } else {
            throw e;
        }
    }
    return mapObj[SK_CRED_MAP] || {};
}

export async function saveCredentials(map: Record<string, any>, cred?: any): Promise<void> {
    let storage = getCredStorage();
    if (!storage) return;
    const toSave: Record<string, any> = { [SK_CRED_MAP]: map };
    if (cred) toSave[SK_CRED] = cred;
    try {
        await storage.set(toSave);
    } catch (e: any) {
        if (String(e?.message || e).includes('not allowed')) {
            markCredSessionFailed();
            storage = chrome.storage.local;
            if (storage) {
                await storage.set(toSave);
            }
        } else {
            throw e;
        }
    }
    if (storage !== chrome.storage.local && chrome.storage.local) {
        try {
            await chrome.storage.local.remove([SK_CRED_MAP, SK_CRED]);
        } catch {
            /* intentional: local purge fallback */
        }
    }
}

// Credential read-modify-write cycles are serialized through one chain: the
// module top-level call, the DOMContentLoaded/load hooks and the MAIN-world
// postMessage listener can all fire back-to-back on page load, and
// unsynchronized load→save cycles would overwrite each other's map entries.
let _credOpChain: Promise<any> = Promise.resolve();
function runSerializedCredOp<T>(op: () => Promise<T>): Promise<T> {
    const run = _credOpChain.then(() => withCredMapLock(op), () => withCredMapLock(op));
    _credOpChain = run.then(() => undefined, () => undefined);
    return run;
}

async function ensureCredsOnce(): Promise<any> {
    try {
        if (!isExtAlive()) return null;
        const atFromPage = extractAtFromPage();
        const blFromPage = extractBlFromPage();
        if (blFromPage) {
            updateContextCreds({ bl: blFromPage });
        }
        if (atFromPage) {
            updateContextCreds({ at: atFromPage });
        }
        const map = await loadCredentialsMap();
        const vals = Object.values(map) as any[];
        if (atFromPage && vals.length === 0) {
            const slot = detectSlotFromUrl();
            const fakeSid = 'page_sid_' + Date.now();
            map[fakeSid] = {
                at: atFromPage,
                sid: fakeSid,
                accountSlot: slot,
                lastUsed: Date.now(),
                bl: blFromPage || (Proto ? Proto.BL_FALLBACK : '')
            };
            await saveCredentials(map, {
                at: atFromPage,
                sid: fakeSid
            });
            updateContextCreds(map[fakeSid]);
            if (isDev()) console.log('[Gemini Exporter] at fallback created fake sid', 'atLen', atFromPage.length, 'blLen', (blFromPage || '').length);
            return map[fakeSid];
        }
        if (atFromPage && vals.length > 0) {
            vals.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
            const best = vals[0];
            if (!best.at || best.at !== atFromPage) {
                best.at = atFromPage;
                best.lastUsed = Date.now();
                if (blFromPage) best.bl = blFromPage;
                map[best.sid || Object.keys(map)[0]] = best;
                await saveCredentials(map, {
                    at: best.at,
                    sid: best.sid
                });
                updateContextCreds(best);
                if (isDev()) console.log('[Gemini Exporter] at refreshed from page', 'atLen', atFromPage.length);
            } else if (blFromPage && best.bl !== blFromPage) {
                best.bl = blFromPage;
                map[best.sid] = best;
                await saveCredentials(map);
                updateContextCreds({ bl: blFromPage });
            }
        } else if (blFromPage && vals.length > 0) {
            vals.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
            const best = vals[0];
            if (best.bl !== blFromPage) {
                best.bl = blFromPage;
                map[best.sid] = best;
                await saveCredentials(map);
                updateContextCreds({ bl: blFromPage });
                if (isDev()) console.log('[Gemini Exporter] bl refreshed', 'blLen', blFromPage.length);
            }
        }
    } catch (e) {
        if (!String(e && (e as any).message || e).includes('Extension context invalidated')) console.warn('ensureCreds fail', e);
    }
    return null;
}

export function ensureCreds(): Promise<any> {
    return runSerializedCredOp(ensureCredsOnce);
}

if (typeof window !== 'undefined') {
    const w = window as any;
    w.__gemExporterExtractAt = extractAtFromPage;
    w.__gemExporterExtractBl = extractBlFromPage;
    w.__gemExporterEnsureCreds = ensureCreds;

    void ensureCreds();
    document.addEventListener('DOMContentLoaded', () => ensureCreds(), { once: true });
    window.addEventListener('load', () => ensureCreds(), { once: true });

    // Listen to GEMINI_CREDENTIALS from the MAIN-world hook. NOTE (threat model):
    // same-window page scripts can forge this message indistinguishably
    // (event.source === window is true for them too), so treat the payload as
    // untrusted: an empty `at` must never clobber the stored credential.
    window.addEventListener('message', (e: MessageEvent) => {
        if (e.source !== window) return;
        if (typeof location !== 'undefined' && e.origin !== location.origin) return;
        if (e.data && e.data.type === (CrossWorldEvents?.CREDENTIALS || 'GEMINI_CREDENTIALS')) {
            if (!isExtAlive()) return;
            // Queued behind any in-flight ensureCreds so concurrent load→save
            // cycles cannot overwrite each other's map entries.
            void runSerializedCredOp(async () => {
                try {
                    const p = (e.data.payload || {}) as Partial<GeminiCredentialsPayload>;
                    const sid = p.sid || '';
                    if (!sid) return;
                    const slot = p.accountSlot || detectSlotFromUrl(p.url || location.href) || 'u0';
                    const profile = sniffUserProfileFromDom();
                    const map = await loadCredentialsMap();
                    const old = map[sid] || {};
                    map[sid] = {
                        at: p.at || old.at || extractAtFromPage() || '',
                        sid,
                        accountSlot: slot || old.accountSlot || 'u0',
                        accountId: profile?.accountId || (old as any).accountId || slot,
                        email: profile?.email || (old as any).email,
                        name: profile?.name || (old as any).name,
                        lastUsed: Date.now(),
                        bl: p.bl || old.bl || extractBlFromPage() || (Proto ? Proto.BL_FALLBACK : '')
                    };
                    await saveCredentials(map, {
                        at: map[sid].at,
                        sid
                    });
                    updateContextCreds(map[sid]);
                    if (profile?.email || profile?.name) {
                        try {
                            const slotUpdate: Record<string, any> = { slot };
                            if (profile.accountId) slotUpdate.accountId = profile.accountId;
                            if (profile.email) slotUpdate.email = profile.email;
                            if (profile.name) slotUpdate.name = profile.name;
                            if (profile.gaiaId) slotUpdate.gaiaId = profile.gaiaId;
                            await StorageService.updateAccountSlot(slot, slotUpdate);
                        } catch { /* best effort */ }
                    }
                    if (isDev()) {
                        console.log('[Gemini Exporter] stored creds from MAIN hook', sid.slice(0, 8), slot, 'at len', (map[sid].at || '').length);
                    }
                } catch (err: any) {
                    if (!String(err?.message || err).includes('Extension context invalidated')) console.warn('creds store fail', err);
                }
            });
        }
    });
}
