export const __bgAborts: Map<string, boolean> = new Map();
let _restorePromise: Promise<void> | null = null;

/**
 * B2: per-slot AbortControllers，与 boolean 旗标镜像同步。
 * abortableSleep / Promise.race 只认 AbortSignal，而旧的 50ms 轮询只翻 boolean 旗标 ——
 * controllers 在两者之间搭桥，让取消即时生效，不再有轮询延迟。
 */
export const __bgControllers: Map<string, AbortController> = new Map();

function getOrCreateController(slot: string): AbortController {
    let c = __bgControllers.get(slot);
    if (!c) {
        c = new AbortController();
        // 旗标同步：boolean 旗标仍为 abort 时（如 worker 重启后从 session 恢复），
        // 新建的 controller 立即 abort，保持"信号与旗标一致"的不变量。
        if (__bgAborts.get(slot)) {
            try { c.abort(); } catch { /* intentional */ }
        }
        __bgControllers.set(slot, c);
    }
    return c;
}

export function getSlotAbortSignal(slot: string = 'u0'): AbortSignal {
    return getOrCreateController(slot || 'u0').signal;
}

/**
 * Restore persisted abort flags after MV3 worker restarts
 * (setSlotAborted mirrors every transition into chrome.storage.session).
 */
export async function restoreAbortFlags(): Promise<void> {
    const p = (async () => {
        try {
            if (typeof chrome !== 'undefined' && chrome.storage && (chrome.storage as any).session && (chrome.storage as any).session.get) {
                const data = await (chrome.storage as any).session.get(null);
                for (const k of Object.keys(data || {})) {
                    const m = k.match(/^gemini_abort_(.+)$/);
                    if (m && data[k]) {
                        __bgAborts.set(m[1], true);
                        try { getOrCreateController(m[1]).abort(); } catch { /* intentional */ }
                    }
                }
            }
        } catch {
            /* intentional: best-effort abort restore */
        }
    })();
    _restorePromise = p;
    await p;
    _restorePromise = null;
}

export function isSlotAborted(slot: string = 'u0'): boolean {
    return !!__bgAborts.get(slot || 'u0');
}

export const __slotEpochs: Map<string, number> = new Map();
const __slotCancelEpochs: Map<string, number> = new Map();

export function getSlotCancelEpoch(slot: string = 'u0'): number {
    return __slotCancelEpochs.get(slot || 'u0') || 0;
}

/**
 * Returns the current monotonically increasing generation/epoch for the given slot.
 * Any batch launched at epoch E will be invalidated if the slot is aborted or reset (epoch changed).
 */
export function getSlotEpoch(slot: string = 'u0'): number {
    return __slotEpochs.get(slot || 'u0') || 0;
}

export async function setSlotAborted(slot: string = 'u0', val: boolean = true): Promise<void> {
    const s = slot || 'u0';
    // Invalidate queued work as soon as cancellation is requested, even if
    // restoring a previous worker's abort flags is still in flight.
    if (val) __slotCancelEpochs.set(s, getSlotCancelEpoch(s) + 1);
    const requestedCancelEpoch = getSlotCancelEpoch(s);
    if (_restorePromise) {
        await _restorePromise;
    }
    if (!val && getSlotCancelEpoch(s) !== requestedCancelEpoch) return;
    __slotEpochs.set(s, getSlotEpoch(s) + 1);
    if (val) {
        __bgAborts.set(s, true);
        try { getOrCreateController(s).abort(); } catch { /* intentional */ }
        try {
            if (typeof chrome !== 'undefined' && chrome.storage && (chrome.storage as any).session) {
                (chrome.storage as any).session.set({ [`gemini_abort_${s}`]: true }).catch(() => {});
            }
        } catch {
            /* intentional: session storage fallback */
        }
    } else {
        __bgAborts.delete(s);
        // 已 abort 的 controller 无法复用，必须新建
        __bgControllers.set(s, new AbortController());
        try {
            if (typeof chrome !== 'undefined' && chrome.storage && (chrome.storage as any).session) {
                (chrome.storage as any).session.remove([`gemini_abort_${s}`]).catch(() => {});
            }
        } catch {
            /* intentional: session storage fallback */
        }
    }
}

export function clearAllAborts(): void {
    __bgAborts.clear();
    __bgControllers.clear();
    __slotEpochs.clear();
    __slotCancelEpochs.clear();
}
