import { normalizeChatId, normalizeRequestId, sameGenerationEvent } from '../src/l1/parsers/shared/resources/generationEvent.js';

// Internal generation comparison consumes decoded identifiers, never raw payloads.
function requiresDecodedIdentity(raw: unknown): void {
    // @ts-expect-error Raw provider input must be decoded before normalization.
    normalizeChatId(raw);
    // @ts-expect-error A request identifier cannot be selected by unchecked input.
    normalizeRequestId(raw);
    // @ts-expect-error Numeric source identifiers must be interpreted by the provider decoder.
    normalizeChatId(123);
    // @ts-expect-error Generation event identities require a decoded chat ID.
    sameGenerationEvent({ chatId: raw, generationOrdinal: 0 }, { chatId: 'chat', generationOrdinal: 0 });
}
void requiresDecodedIdentity;
