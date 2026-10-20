export interface ExportSessionData {
    status?: 'running' | 'completed' | 'interrupted' | 'error' | string;
    slot?: string;
    total?: number;
    current?: number;
    lastChatId?: string;
    lastChatTitle?: string;
    format?: string;
    useZip?: boolean;
    error?: string;
    updatedAt?: number;
    [key: string]: any;
}

import { STORAGE_KEYS } from '../utils/constants.js';

export const EXPORT_SESSION_KEY = STORAGE_KEYS.LAST_EXPORT_SESSION;

// P2-11: updateSession 曾是无锁 get→merge→set，跨 tab 会丢更新（lost update）。
// 照 storageService.ts 的既定模式：navigator.locks 做跨 tab 全局互斥，
// 模块内内存 promise 链做同 tab 串行 + 无 Web Locks 环境的 fallback。
// 锁在链内部获取：tab 只在临界区内持有全局锁，不会在排队等自己前面的任务时占锁。
const SESSION_XTAB_LOCK = 'gemini-exporter:write:session';
let _sessionChain: Promise<void> = Promise.resolve();

function getWebLocks(): { request(name: string, fn: () => Promise<any>): Promise<any> } | null {
    try {
        const nav = typeof navigator !== 'undefined' ? (navigator as any) : undefined;
        if (nav && nav.locks && typeof nav.locks.request === 'function') {
            return nav.locks;
        }
    } catch { /* intentional: non-window contexts fall back to in-memory chain */ }
    return null;
}

function withSessionLock<T>(fn: () => Promise<T>): Promise<T> {
    const locks = getWebLocks();
    const run = () => (locks ? locks.request(SESSION_XTAB_LOCK, fn) : fn());
    const p = _sessionChain.then(run, run);
    _sessionChain = p.then(() => undefined, () => undefined);
    return p;
}

export async function getSession(): Promise<ExportSessionData | null> {
    try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            const data = await chrome.storage.local.get([EXPORT_SESSION_KEY]);
            return (data && data[EXPORT_SESSION_KEY]) ? (data[EXPORT_SESSION_KEY] as ExportSessionData) : null;
        }
    } catch (e) {
        console.debug('[GemExporter:sessionStore] getSession error', e);
    }
    return null;
}

export async function setSession(session: Partial<ExportSessionData>): Promise<void> {
    return withSessionLock(async () => {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            const payload = {
                ...session,
                updatedAt: session.updatedAt || Date.now()
            };
            try {
                await chrome.storage.local.set({ [EXPORT_SESSION_KEY]: payload });
            } catch (e) {
                console.error('[GemExporter:sessionStore] setSession error', e);
                throw e;
            }
        }
    });
}

export async function updateSession(patch: Partial<ExportSessionData>): Promise<void> {
    return withSessionLock(async () => {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            const current = (await getSession()) || {};
            const merged = {
                ...current,
                ...patch,
                updatedAt: Date.now()
            };
            try {
                await chrome.storage.local.set({ [EXPORT_SESSION_KEY]: merged });
            } catch (e) {
                console.error('[GemExporter:sessionStore] updateSession error', e);
                throw e;
            }
        }
    });
}

export async function clearSession(): Promise<void> {
    return withSessionLock(async () => {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            try {
                await chrome.storage.local.remove([EXPORT_SESSION_KEY]);
            } catch (e) {
                console.error('[GemExporter:sessionStore] clearSession error', e);
                throw e;
            }
        }
    });
}

export const SessionStore = {
    EXPORT_SESSION_KEY,
    getSession,
    setSession,
    updateSession,
    clearSession
};

export default SessionStore;
