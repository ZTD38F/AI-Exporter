import { parseGeminiCredential, type GeminiStoredCredential } from '../../parsers/gemini/credentials.js';
import { CrossWorldEvents, GeminiProtocol, type GeminiProtocolModule } from '../../protocol/gemini/protocol.js';
import type { GeminiCredentialsPayload } from '../../protocol/gemini/events.js';
import { STORAGE_KEYS } from '../../../shared/utils/constants.js';
import {
    getCredStorage as sharedGetCredStorage,
    markCredSessionAccessFailed as sharedMarkFailed,
    withCredMapLock,
} from './api/credStorage.js';
import { resolveCurrentAccount, matchesCurrentAccount } from '../../../runtime/content/accountContext.js';
import { readAccountParameters } from '../../../l2/accountRegistry.js';
import { registerCleanup } from '../../../runtime/content/cleanupRegistry.js';
import { getErrorMessage } from '../../../shared/utils/errorText.js';

export function getCredStorage(): chrome.storage.StorageArea | null {
    return sharedGetCredStorage();
}

function markCredSessionFailed(): void {
    sharedMarkFailed();
}

const SK_CRED_MAP = STORAGE_KEYS.CREDENTIALS_MAP;
const SK_CRED = STORAGE_KEYS.CREDENTIALS;

const Proto: GeminiProtocolModule = GeminiProtocol;

function isDev(): boolean {
    const ctx = window.__gemExporterContentContext;
    return ctx ? ctx.isDevMode() : !!window.__gemExporterDevMode;
}

type BootstrapCredential = GeminiStoredCredential;

function updateContextCreds(creds: BootstrapCredential): void {
    window.__gemExporterContentContext?.setCredentials(creds);
}

export function extractAtFromPage(): string {
    if (!Proto) return '';
    try {
        try {
            if (window.__gemExporterExtractedAt && window.__gemExporterExtractedAt.length > 15) {
                return window.__gemExporterExtractedAt;
            }
            if (window.__geminiAt && window.__geminiAt.length > 15) {
                return window.__geminiAt;
            }
        } catch (e) {
            if (isDev()) console.debug('[GemExporter:bootstrap.ts]', e);
        }

        try {
            const w = window;
            for (const wiz of [w._WIZ_global_data, w.WIZ_global_data, w.__WIZ_global_data]) {
                if (!wiz || typeof wiz !== 'object' || !(Proto.TOKENS.AT in wiz)) continue;
                const token: unknown = Reflect.get(wiz, Proto.TOKENS.AT);
                if (typeof token === 'string' && token) return token;
            }
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

export async function loadCredentialsMap(): Promise<Map<string, BootstrapCredential>> {
    let storage = getCredStorage();
    if (!storage) return new Map();
    let mapObj: Record<string, unknown> = {};
    try {
        mapObj = await storage.get([SK_CRED_MAP]);
    } catch (e: unknown) {
        if (getErrorMessage(e).includes('not allowed')) {
            markCredSessionFailed();
            storage = chrome.storage.local;
            if (storage) {
                mapObj = await storage.get([SK_CRED_MAP]);
            }
        } else {
            throw e;
        }
    }
    const saved = mapObj[SK_CRED_MAP];
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return new Map();
    return new Map(Object.keys(saved).map(sid => [sid, parseGeminiCredential(Reflect.get(saved, sid))]));
}

export async function saveCredentials(map: ReadonlyMap<string, BootstrapCredential>, cred?: Partial<GeminiCredentialsPayload>): Promise<void> {
    let storage = getCredStorage();
    if (!storage) return;
    const toSave = { [SK_CRED_MAP]: Object.fromEntries(map), ...(cred ? { [SK_CRED]: cred } : {}) };
    try {
        await storage.set(toSave);
    } catch (e: unknown) {
        if (getErrorMessage(e).includes('not allowed')) {
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

async function ensureCredsOnce(): Promise<BootstrapCredential | null> {
    try {
        if (!isExtAlive()) return null;
        const atFromPage = extractAtFromPage();
        const account = await resolveCurrentAccount();
        const blFromPage = extractBlFromPage();
        if (blFromPage) {
            updateContextCreds({ bl: blFromPage });
        }
        if (atFromPage) {
            updateContextCreds({ at: atFromPage });
        }
        const map = await loadCredentialsMap();
        const vals = [...map.values()];
        if (atFromPage && vals.length === 0) {
            const slot = detectSlotFromUrl();
            const fakeSid = 'page_sid_' + Date.now();
            const credential: BootstrapCredential = {
                at: atFromPage,
                sid: fakeSid,
                accountSlot: slot,
                accountId: account?.accountId,
                lastUsed: Date.now(),
                bl: blFromPage || (Proto ? Proto.BL_FALLBACK : '')
            };
            map.set(fakeSid, credential);
            await saveCredentials(map, {
                at: atFromPage,
                sid: fakeSid
            });
            updateContextCreds(credential);
            if (isDev()) console.log('[Gemini Exporter] at fallback created fake sid', 'atLen', atFromPage.length, 'blLen', (blFromPage || '').length);
            return credential;
        }
        if (atFromPage && vals.length > 0) {
            vals.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
            const best = vals[0];
            if (!best.at || best.at !== atFromPage) {
                best.at = atFromPage;
                best.lastUsed = Date.now();
                if (blFromPage) best.bl = blFromPage;
                map.set(best.sid || [...map.keys()][0], best);
                await saveCredentials(map, {
                    at: best.at,
                    sid: best.sid
                });
                updateContextCreds(best);
                if (isDev()) console.log('[Gemini Exporter] at refreshed from page', 'atLen', atFromPage.length);
            } else if (blFromPage && best.bl !== blFromPage) {
                best.bl = blFromPage;
                map.set(String(best.sid), best);
                await saveCredentials(map);
                updateContextCreds({ bl: blFromPage });
            }
        } else if (blFromPage && vals.length > 0) {
            vals.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
            const best = vals[0];
            if (best.bl !== blFromPage) {
                best.bl = blFromPage;
                map.set(String(best.sid), best);
                await saveCredentials(map);
                updateContextCreds({ bl: blFromPage });
                if (isDev()) console.log('[Gemini Exporter] bl refreshed', 'blLen', blFromPage.length);
            }
        }
    } catch (e) {
        if (!getErrorMessage(e).includes('Extension context invalidated')) console.warn('ensureCreds fail', e);
    }
    return null;
}

/** One shared credential-map queue protects bootstrap hooks, messages and API writers. */
export function ensureCreds(): Promise<BootstrapCredential | null> {
    return withCredMapLock(ensureCredsOnce);
}

export function initBootstrap(): void {
    window.__gemExporterExtractAt = extractAtFromPage;
    window.__gemExporterExtractBl = extractBlFromPage;
    window.__gemExporterEnsureCreds = ensureCreds;

    void ensureCreds();
    const refresh = () => { void ensureCreds(); };
    document.addEventListener('DOMContentLoaded', refresh, { once: true });
    window.addEventListener('load', refresh, { once: true });
    registerCleanup(() => { document.removeEventListener('DOMContentLoaded', refresh); window.removeEventListener('load', refresh); });

    // Listen to GEMINI_CREDENTIALS from the MAIN-world hook. NOTE (threat model):
    // same-window page scripts can forge this message indistinguishably
    // (event.source === window is true for them too), so treat the payload as
    // untrusted: an empty `at` must never clobber the stored credential.
    const receive = (e: MessageEvent<unknown>) => {
        if (e.source !== window) return;
        if (typeof location !== 'undefined' && e.origin !== location.origin) return;
        const data = e.data;
        if (!data || typeof data !== 'object' || !('type' in data)) return;
        if (data.type === CrossWorldEvents.ACCOUNT_OBSERVED) {
            if (!isExtAlive()) return;
            const payload = 'payload' in data ? data.payload : undefined;
            if (!payload || typeof payload !== 'object' || !('observation' in payload) || !('slot' in payload) || typeof payload.slot !== 'string') return;
            if ('requestId' in payload) return; // The requesting resolver owns this reply.
            // The same-window payload is untrusted and is validated before Registry access.
            try {
                const observation = payload.observation === null ? null : readAccountParameters(payload.observation);
                void resolveCurrentAccount(observation, payload.slot).catch(error => console.warn('[Gemini Exporter] Account discovery failed', getErrorMessage(error)));
            } catch (error) { if (isDev()) console.debug('[Gemini Exporter] Invalid account observation', error); }
            return;
        }
        if (data && data.type === (CrossWorldEvents?.CREDENTIALS || 'GEMINI_CREDENTIALS')) {
            if (!isExtAlive()) return;
            // Queued behind any in-flight ensureCreds so concurrent load→save
            // cycles cannot overwrite each other's map entries.
            void withCredMapLock(async () => {
                try {
                    const p = parseGeminiCredential('payload' in data ? data.payload : undefined);
                    const slot = p.accountSlot === 'default' ? 'u0' : p.accountSlot || detectSlotFromUrl(p.url || location.href) || 'u0';
                    // Queued credentials can belong to the previous Gaia even
                    // when slot/email stayed the same. Refresh before binding.
                    const currentAccount = await resolveCurrentAccount(undefined, slot);
                    const account = p.accountObservation && matchesCurrentAccount(p.accountObservation) ? currentAccount : null;
                    const profile = account && p.accountObservation ? {
                        email: p.accountObservation.email, name: p.accountObservation.displayName,
                        gaiaId: p.accountObservation.providerAccountId,
                    } : undefined;
                    const sid = p.sid || '';
                    if (!sid) return;
                    const map = await loadCredentialsMap();
                    const old = map.get(sid) ?? {};
                    const credential: BootstrapCredential = {
                        at: p.at || old.at || extractAtFromPage() || '',
                        sid,
                        accountSlot: slot || old.accountSlot || 'u0',
                        accountId: account?.accountId,
                        email: profile?.email || old.email,
                        name: profile?.name || old.name,
                        lastUsed: Date.now(),
                        bl: p.bl || old.bl || extractBlFromPage() || (Proto ? Proto.BL_FALLBACK : '')
                    };
                    map.set(sid, credential);
                    await saveCredentials(map, {
                        at: credential.at,
                        sid
                    });
                    updateContextCreds(credential);
                    if (isDev()) {
                        console.log('[Gemini Exporter] stored creds from MAIN hook', sid.slice(0, 8), slot, 'at len', (credential.at || '').length);
                    }
                } catch (err: unknown) {
                    if (!getErrorMessage(err).includes('Extension context invalidated')) console.warn('creds store fail', err);
                }
            });
        }
    };
    window.addEventListener('message', receive);
    registerCleanup(() => window.removeEventListener('message', receive));
}
