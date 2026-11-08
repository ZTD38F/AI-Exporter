import type { GeminiCredentialsPayload } from '../../protocol/gemini/events.js';
import { readAccountParameters } from '../../../l2/accountRegistry.js';

export type GeminiStoredCredential = Partial<GeminiCredentialsPayload> & { accountId?: string; email?: string; name?: string };

/** Storage and MAIN messages are separate untrusted inputs, sharing one credential schema. */
export function parseGeminiCredential(raw: unknown): GeminiStoredCredential {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const result: GeminiStoredCredential = {};
    const textFields: Exclude<keyof GeminiStoredCredential, 'lastUsed' | 'accountObservation'>[] =
        ['at', 'sid', 'bl', 'accountSlot', 'url', 'accountId', 'email', 'name'];
    for (const key of textFields) {
        const value: unknown = Reflect.get(raw, key);
        if (typeof value === 'string') result[key] = value;
    }
    const lastUsed: unknown = Reflect.get(raw, 'lastUsed');
    if (typeof lastUsed === 'number' && Number.isFinite(lastUsed)) result.lastUsed = lastUsed;
    const observation: unknown = Reflect.get(raw, 'accountObservation');
    if (observation) result.accountObservation = readAccountParameters(observation);
    return result;
}
