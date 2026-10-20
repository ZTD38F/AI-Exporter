import type { IProgressView } from '../../types/ui.js';

let _hideTimer: any = null;

function getEl(id: string): HTMLElement | null {
    if (typeof document === 'undefined') return null;
    return document.getElementById(id);
}

function getElement(type: 'wrap' | 'bar' | 'text'): HTMLElement | null {
    if (type === 'wrap') return getEl('progWrap');
    if (type === 'bar') return getEl('bar');
    if (type === 'text') return getEl('progText');
    return null;
}

export function show(initialPct?: number, text?: string): void {
    if (_hideTimer) {
        clearTimeout(_hideTimer);
        _hideTimer = null;
    }
    const wrap = getElement('wrap');
    if (wrap) wrap.style.display = 'block';

    if (typeof initialPct === 'number') {
        const bar = getElement('bar');
        const clamped = Math.min(Math.max(initialPct, 0), 100);
        if (bar) bar.style.width = `${clamped}%`;
    }

    if (typeof text === 'string') {
        const textEl = getElement('text');
        if (textEl) textEl.textContent = text;
    }
}

export function update(pct: number, text?: string): void {
    if (_hideTimer) {
        clearTimeout(_hideTimer);
        _hideTimer = null;
    }
    const wrap = getElement('wrap');
    if (wrap && wrap.style.display === 'none') {
        wrap.style.display = 'block';
    }

    const bar = getElement('bar');
    const clamped = Math.min(Math.max(Number(pct) || 0, 0), 100);
    if (bar) bar.style.width = `${clamped}%`;

    if (typeof text === 'string') {
        const textEl = getElement('text');
        if (textEl) textEl.textContent = text;
    }
}

export function complete(text?: string): void {
    const bar = getElement('bar');
    if (bar) bar.style.width = '100%';

    if (typeof text === 'string') {
        const textEl = getElement('text');
        if (textEl) textEl.textContent = text;
    }
}

export function reset(): void {
    if (_hideTimer) {
        clearTimeout(_hideTimer);
        _hideTimer = null;
    }
    const bar = getElement('bar');
    if (bar) bar.style.width = '0%';
    const textEl = getElement('text');
    if (textEl) textEl.textContent = '';
}

export function hide(delayMs: number = 0): void {
    if (_hideTimer) {
        clearTimeout(_hideTimer);
        _hideTimer = null;
    }
    if (delayMs > 0) {
        _hideTimer = setTimeout(() => {
            _hideTimer = null;
            const wrap = getElement('wrap');
            if (wrap) wrap.style.display = 'none';
            reset();
        }, delayMs);
    } else {
        const wrap = getElement('wrap');
        if (wrap) wrap.style.display = 'none';
        reset();
    }
}

export const ProgressView: IProgressView = {
    show,
    update,
    complete,
    reset,
    hide
};


export default ProgressView;
