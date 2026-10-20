import type { IAccountView } from '../../types/ui.js';
import { $, t } from '../uiCommon.js';

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
        const email = info?.email || '';
        const isDefaultAutoName = !rawName || /^账号\s*u\d+/i.test(rawName) || /^account\s*u\d+/i.test(rawName) || /^默认账号/i.test(rawName) || /^default account/i.test(rawName);
        let label: string;
        if (email) {
            label = (!isDefaultAutoName && rawName) ? `${rawName} (${email})` : `${email} [${s}]`;
        } else {
            label = isDefaultAutoName ? (s === 'u0' ? defLabel : `${accLabel} ${s.toUpperCase()}`) : rawName;
        }
        const count = typeof info?.count === 'number' ? ` (${info.count})` : '';
        const opt = document.createElement('option');
        opt.value = s;
        opt.selected = s === currentSlot;
        opt.textContent = `${label}${count}`;
        sel.appendChild(opt);
    }
}

export const AccountView: IAccountView = {
    render
};


export default AccountView;
