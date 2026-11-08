import type { Account } from '../../src/l2/accountRegistry.js';
import { ACCOUNT_UUID, OTHER_ACCOUNT_UUID } from './accountRuntime.js';

/** Explicit fixture Accounts, shared by storage-only chrome mocks. */
export function withRegistry<T extends object>(mock: T, extra: Account[] = []): T {
    const accounts: Account[] = [
        { id: ACCOUNT_UUID, providerId: 'gemini', providerAccountId: '10000000001' },
        { id: OTHER_ACCOUNT_UUID, providerId: 'gemini', providerAccountId: '10000000002' },
        ...extra,
    ];
    const runtime: any = Reflect.get(mock, 'runtime');
    const send = runtime?.sendMessage;
    return Object.assign(mock, { runtime: { ...runtime, async sendMessage(message: Record<string, unknown>, ...args: unknown[]) {
        if (message.action === 'ensureV2Ready') return { ok: true };
        if (message.action !== 'accountRegistry') return send?.call(runtime, message, ...args);
        if (message.command === 'get') return { ok: true, value: accounts.find(a => a.id === message.accountId) ?? null };
        if (message.command === 'list') return { ok: true, value: accounts.filter(a => !message.providerId || a.providerId === message.providerId) };
        const found = accounts.find(a => a.providerId === message.providerId && a.providerAccountId === message.providerAccountId);
        const created = found ?? { id: crypto.randomUUID(), providerId: String(message.providerId), providerAccountId: String(message.providerAccountId) };
        if (!found) accounts.push(created);
        return { ok: true, value: created };
    } } });
}
