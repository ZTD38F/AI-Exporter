// src/ui/views/accountView.ts - Account Slot Selector View
import type { IAccountView } from '../../types/ui.js';

const t = (key: string, ...args: any[]): string => {
    if (typeof I18n !== 'undefined' && I18n.t) {
        return I18n.t(key, ...args);
    }
    return key;
};

function $(id: string): HTMLElement | null {
    return typeof document !== 'undefined' ? document.getElementById(id) : null;
}

export function render(accountSlots: Record<string, any>, currentSlot: string): void {
    const sel = $('accountSlotSelect') as HTMLSelectElement | null;
    if (!sel) return;
    const slots = Object.keys(accountSlots || {});
    if (slots.length <= 1 && (!slots.includes('u1') && !slots.includes('u2'))) {
        sel.style.display = 'none';
        return;
    }
    sel.style.display = 'inline-block';
    sel.innerHTML = '';
    const sorted = Array.from(new Set(['u0', ...slots])).sort();
    const defLabel = typeof t === 'function' ? t('defaultAccount') : 'Default Account (u0)';
    const accLabel = typeof t === 'function' ? t('accountSlot') : 'Account';
    for (const s of sorted) {
        const info = accountSlots[s];
        const rawName = info?.name || '';
        const isDefaultAutoName = !rawName || /^账号\s*u\d+/i.test(rawName) || /^account\s*u\d+/i.test(rawName) || /^默认账号/i.test(rawName) || /^default account/i.test(rawName);
        const label = isDefaultAutoName ? (s === 'u0' ? defLabel : `${accLabel} ${s.toUpperCase()}`) : rawName;
        const count = typeof info?.count === 'number' ? ` (${info.count})` : '';
        const opt = document.createElement('option');
        opt.value = s;
        opt.selected = s === currentSlot;
        opt.textContent = `${label}${count}`;
        sel.appendChild(opt);
    }
}

export function bindChange(callback: (slot: string) => void): void {
    const sel = $('accountSlotSelect');
    if (!sel) return;
    sel.addEventListener('change', (e: Event) => {
        if (callback) callback((e.target as HTMLSelectElement).value);
    });
}

export const AccountView: IAccountView = {
    render,
    bindChange
};

(AccountView as any).AccountView = AccountView;
(AccountView as any).default = AccountView;

if (typeof globalThis !== 'undefined') {
    (globalThis as any).AccountView = AccountView;
}
if (typeof module === 'object' && module.exports) {
    module.exports = AccountView;
}
export default AccountView;
