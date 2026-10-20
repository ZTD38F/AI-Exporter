import { contentContext } from './contentContext.js';
import { extractConversationIdFromUrl } from '../core/utils/pathUtils.js';

export type LiveTurnCallback = (conversationId: string, reason: 'turn_complete' | 'location_change' | 'unload') => void;

export interface LiveSaveObserverOptions {
    debounceMs?: number;
    onTurnComplete?: LiveTurnCallback;
    getActiveId?: () => string | null;
}

let __mutationObserver: MutationObserver | null = null;
let __debounceTimer: any = null;
let __isGenerating = false;
let __pendingConversationId: string | null = null;
let __options: LiveSaveObserverOptions = {};
let __initialized = false;
let _rafPending = false;

function __onLocationChange(): void {
    if (__isGenerating || __debounceTimer) {
        triggerSave('location_change');
    }
    __isGenerating = false;
}

function __onBeforeUnload(): void {
    if (__isGenerating || __debounceTimer) {
        triggerSave('unload');
    }
}

function isDev(): boolean {
    return contentContext.isDevMode();
}

export function checkIsGeneratingDOM(): boolean {
    if (typeof document === 'undefined') return false;

    const stopSelectors = [
        'button[aria-label*="Stop"]',
        'button[aria-label*="停止"]',
        'button[aria-label*="Arrêter"]',
        'button[aria-label*="Stoppen"]',
        'button[data-test-id*="stop"]',
        '[data-test-id="stop-button"]',
        '.stop-generating-button',
        'mat-icon[fonticon="stop"]',
        'mat-icon[fonticon="pause"]'
    ];
    for (const sel of stopSelectors) {
        const el = document.querySelector(sel);
        if (el && (el as HTMLElement).offsetParent !== null) {
            return true;
        }
    }

    const streamingSelectors = [
        'model-response.loading',
        'model-response.generating',
        '[data-is-generating="true"]',
        '.model-response-text-loading',
        '.sparkle-loading',
        '.streaming'
    ];
    for (const sel of streamingSelectors) {
        const el = document.querySelector(sel);
        if (el) return true;
    }

    return false;
}

export function getActiveConversationId(): string | null {
    if (typeof location === 'undefined') return null;
    return extractConversationIdFromUrl(location.pathname);
}

function triggerSave(reason: 'turn_complete' | 'location_change' | 'unload'): void {
    if (__debounceTimer) {
        clearTimeout(__debounceTimer);
        __debounceTimer = null;
        contentContext.clearTimer('liveSaveDebounce');
    }

    const cid = __pendingConversationId || (__options.getActiveId ? __options.getActiveId() : getActiveConversationId());
    if (!cid) return;

    if (isDev()) {
        console.log(`[LiveSaveObserver] Triggering live save for ${cid}, reason: ${reason}`);
    }

    if (typeof __options.onTurnComplete === 'function') {
        try {
            __options.onTurnComplete(cid, reason);
        } catch (e) {
            console.warn('[LiveSaveObserver] onTurnComplete callback error:', e);
        }
    }
}

function scheduleDebouncedTurnComplete(cid: string, delayMs: number): void {
    __pendingConversationId = cid;
    if (__debounceTimer) {
        clearTimeout(__debounceTimer);
        __debounceTimer = null;
    }

    __debounceTimer = setTimeout(() => {
        __debounceTimer = null;
        contentContext.clearTimer('liveSaveDebounce');
        // Final sanity check: if still generating, postpone
        if (checkIsGeneratingDOM()) {
            scheduleDebouncedTurnComplete(cid, 500);
            return;
        }
        __isGenerating = false;
        triggerSave('turn_complete');
    }, delayMs);

    contentContext.registerTimer('liveSaveDebounce', __debounceTimer);
}

function handleDOMChange(): void {
    const cid = __options.getActiveId ? __options.getActiveId() : getActiveConversationId();
    if (!cid) return;

    const generatingNow = checkIsGeneratingDOM();

    if (generatingNow) {
        __isGenerating = true;
        __pendingConversationId = cid;
        // If generating, cancel any pending save trigger
        if (__debounceTimer) {
            clearTimeout(__debounceTimer);
            __debounceTimer = null;
            contentContext.clearTimer('liveSaveDebounce');
        }
    } else if (__isGenerating) {
        // Transition: GENERATING -> IDLE
        const delay = __options.debounceMs || 300;
        scheduleDebouncedTurnComplete(cid, delay);
    }
}

export function init(options: LiveSaveObserverOptions = {}): void {
    if (typeof window === 'undefined') return;
    __options = options;
    cleanup();

    const targetNode = document.body || document.documentElement;
    if (targetNode) {
        __mutationObserver = new MutationObserver(() => {
            if (_rafPending) return;
            _rafPending = true;
            requestAnimationFrame(() => {
                _rafPending = false;
                handleDOMChange();
            });
        });
        __mutationObserver.observe(targetNode, {
            childList: true,
            subtree: true,
            characterData: true
        });
        contentContext.registerTimer('liveSaveObserver', __mutationObserver);
    }

    // Emergency flush on route change
    window.addEventListener('gemini:locationchange', __onLocationChange);
    window.addEventListener('popstate', __onLocationChange);

    // Emergency flush on beforeunload
    window.addEventListener('beforeunload', __onBeforeUnload);

    __initialized = true;
    if (isDev()) console.log('[LiveSaveObserver] Initialized');
}

export function cleanup(): void {
    if (__debounceTimer) {
        clearTimeout(__debounceTimer);
        __debounceTimer = null;
        contentContext.clearTimer('liveSaveDebounce');
    }
    if (__mutationObserver) {
        __mutationObserver.disconnect();
        __mutationObserver = null;
        contentContext.clearTimer('liveSaveObserver');
    }
    if (typeof window !== 'undefined') {
        window.removeEventListener('gemini:locationchange', __onLocationChange);
        window.removeEventListener('popstate', __onLocationChange);
        window.removeEventListener('beforeunload', __onBeforeUnload);
    }
    __isGenerating = false;
    __pendingConversationId = null;
    __initialized = false;
}

export function isObserverActive(): boolean {
    return __initialized;
}

export function flushCurrentTurnNow(): void {
    triggerSave('turn_complete');
}

export function notifyStreamStart(cid?: string | null): void {
    const activeId = cid || (__options.getActiveId ? __options.getActiveId() : getActiveConversationId());
    __isGenerating = true;
    if (activeId) {
        __pendingConversationId = activeId;
    }
    if (__debounceTimer) {
        clearTimeout(__debounceTimer);
        __debounceTimer = null;
        contentContext.clearTimer('liveSaveDebounce');
    }
    if (isDev()) {
        console.log(`[LiveSaveObserver] RPC Stream started for ${__pendingConversationId || 'current chat'}`);
    }
}

export function notifyStreamComplete(cid?: string | null): void {
    const activeId = cid || __pendingConversationId || (__options.getActiveId ? __options.getActiveId() : getActiveConversationId());
    if (activeId) {
        __pendingConversationId = activeId;
    }
    __isGenerating = false;

    if (__debounceTimer) {
        clearTimeout(__debounceTimer);
        __debounceTimer = null;
        contentContext.clearTimer('liveSaveDebounce');
    }

    if (isDev()) {
        console.log(`[LiveSaveObserver] RPC Stream completed for ${activeId || 'current chat'}, triggering instant save`);
    }

    // Micro-delay (50ms) to allow DOM to commit any syntax highlighting/math rendering, then trigger save
    const timer = setTimeout(() => {
        triggerSave('turn_complete');
    }, 50);
    contentContext.registerTimer('liveSaveDebounce', timer);
}

export const LiveSaveObserver = {
    init,
    cleanup,
    isObserverActive,
    checkIsGeneratingDOM,
    getActiveConversationId,
    notifyStreamStart,
    notifyStreamComplete,
    flushCurrentTurnNow
};

export default LiveSaveObserver;
