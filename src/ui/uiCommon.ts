// src/ui/uiCommon.ts - Shared UI helpers (Phase E.1)
import { I18n } from '../core/utils/i18n.js';
import { normId, cleanTitle, isRealTitle } from '../core/utils/utils.js';

export const $ = (id: string): HTMLElement | null =>
    typeof document !== 'undefined' ? document.getElementById(id) : null;

export const t = (key: string, ...args: any[]): string => {
    const g: any = (typeof I18n !== 'undefined' && I18n ? I18n : (typeof globalThis !== 'undefined' ? (globalThis as any).I18n : null));
    return g && typeof g.t === 'function' ? g.t(key, ...args) : key;
};

export { normId, cleanTitle, isRealTitle };
