import type { SourceAttachmentInput } from '../../../src/l1/parsers/shared/resources/resolveResources.js';
type GenerationIdentity = NonNullable<SourceAttachmentInput['generation']>;

export type GenerationAttachment = {
    type?: string;
    localName?: string;
    url?: unknown;
    sourceUrl?: unknown;
    resolvedUrl?: unknown;
    src?: unknown;
    token?: unknown;
    dataBuffer?: unknown;
    blobBase64?: string;
    isGenerated?: boolean;
    providerRequestId?: string;
    generation?: GenerationIdentity;
    imageOrdinal?: number;
    fileName?: string;
};

export type GenerationMessage = {
    role?: unknown;
    content?: unknown;
    id?: string;
    timestamp?: unknown;
    turnId?: string;
    providerRequestId?: string;
    generation?: GenerationIdentity;
    images?: GenerationAttachment[] | null;
    attachments?: GenerationAttachment[] | null;
};

import { sameGenerationEvent, normalizeRequestId, normalizeChatId, eventSecond } from '../../../src/l1/parsers/shared/resources/generationEvent.js';

/** Resolve only a unique prompt/time event and its sole response, never a first/last turn guess. */
export function findGenerationModelMessage<T extends GenerationMessage>(chat: { id?: string; messages?: T[] }, generation: GenerationIdentity): T | null {
    if (chat?.id && normalizeChatId(chat.id) !== normalizeChatId(generation.chatId)) return null;
    const messages: T[] = Array.isArray(chat?.messages) ? chat.messages : [];

    const targetReq = normalizeRequestId(generation.providerRequestId);
    if (targetReq) {
        const direct = messages.filter((m) =>
            (m.role === 'model' || m.role === 'assistant') &&
            normalizeRequestId(m.providerRequestId) === targetReq
        );
        if (direct.length === 1) return direct[0];
        if (direct.length > 1) return null;

        // Legacy message/turn identity is evidence only at construction time.
        const legacyModels = messages.filter((m) =>
            (m.role === 'model' || m.role === 'assistant') &&
            (normalizeRequestId(m.id) === targetReq || normalizeRequestId(m.turnId) === targetReq));
        if (legacyModels.length === 1) return legacyModels[0];
        if (legacyModels.length > 1) return null;
        const users = messages.map((m, index) => ({ m, index })).filter(({ m }) =>
            m.role === 'user' && (normalizeRequestId(m.providerRequestId) === targetReq
                || normalizeRequestId(m.id) === targetReq || normalizeRequestId(m.turnId) === targetReq));
        if (users.length > 1) return null;
        if (users.length === 1) return soleResponse(messages, users[0].index, targetReq);
    }

    const marked = messages.filter((m) => (m.role === 'model' || m.role === 'assistant') && m.generation && sameGenerationEvent({ ...m.generation, time: m.generation.time ?? undefined }, { ...generation, time: generation.time ?? undefined }));
    if (marked.length === 1) return marked[0];
    if (marked.length > 1 || eventSecond(generation.time ?? undefined) === null || !generation.prompt) return null;
    const users = messages.map((m, index) => ({ m, index })).filter(({ m }) =>
        m.role === 'user' && typeof m.content === 'string'
        && m.content.trim() === generation.prompt!.trim()
        && eventSecond(typeof m.timestamp === 'number' ? m.timestamp : undefined) === eventSecond(generation.time ?? undefined));
    if (users.length !== 1) return null;
    return soleResponse(messages, users[0].index, targetReq);
}

function soleResponse<T extends GenerationMessage>(messages: T[], userIndex: number, targetReq: string | null): T | null {
    const models: T[] = [];
    for (let i = userIndex + 1; i < messages.length && messages[i].role !== 'user'; i++) {
        if (messages[i].role === 'model' || messages[i].role === 'assistant') models.push(messages[i]);
    }
    if (models.length !== 1) return null;
    const response = models[0];
    const responseRequest = normalizeRequestId(response.providerRequestId || response.generation?.providerRequestId);
    return targetReq && responseRequest && targetReq !== responseRequest ? null : response;
}

function hasReliableGenerationIdentity(image: GenerationAttachment, generation: GenerationIdentity): boolean {
    if (!image || typeof image !== 'object') return false;
    if (image.isGenerated === true) return true;

    const genReq = normalizeRequestId(generation.providerRequestId);
    if (genReq) {
        const imgReq = normalizeRequestId(image.providerRequestId || image.generation?.providerRequestId);
        if (imgReq && imgReq === genReq) return true;
    }

    if (image.generation && sameGenerationEvent({ ...image.generation, time: image.generation.time ?? undefined }, { ...generation, time: generation.time ?? undefined })) {
        return true;
    }

    return false;
}

export function hasGenerationImage(message: GenerationMessage, generation: GenerationIdentity): boolean {
    const rawImages = [...(message?.images || []), ...(message?.attachments || [])].filter(Boolean);

    // Only inspect images with reliable generation identity.
    // Ordinary inline/grounding images (isGenerated !== true) MUST NEVER be treated as generated images.
    const candidateImages = rawImages.filter((img) => hasReliableGenerationIdentity(img, generation));
    if (candidateImages.length === 0) {
        return false;
    }

    const genReq = normalizeRequestId(generation.providerRequestId);
    const genOrd = generation.imageOrdinal ?? (generation.imageCount === 1 ? 0 : undefined);
    // Request identity locates the event, but cannot identify an unknown image in a multi-image event.
    if (genOrd === undefined) return false;

    if (genReq) {
        for (const image of candidateImages) {
            const imgReq = normalizeRequestId(image.providerRequestId || image.generation?.providerRequestId);
            if (imgReq === genReq) {
                const imgOrd = image.imageOrdinal ?? image.generation?.imageOrdinal
                    ?? ((image.generation?.imageCount ?? generation.imageCount) === 1 ? 0 : undefined);
                if (imgOrd === genOrd) {
                    if (!image.generation) image.generation = { ...generation, turnId: message.id };
                    message.generation = { ...generation, turnId: message.id };
                    return true;
                }
            }
        }
        const msgReq = normalizeRequestId(message.providerRequestId || message.generation?.providerRequestId);
        if (msgReq === genReq) {
            if (genOrd === 0 && generation.imageCount === 1) {
                if (!candidateImages[0].generation) candidateImages[0].generation = { ...generation, turnId: message.id };
                message.generation = { ...generation, turnId: message.id };
                return true;
            }
            for (const image of candidateImages) {
                const imgOrd = image.imageOrdinal ?? image.generation?.imageOrdinal
                    ?? ((image.generation?.imageCount ?? generation.imageCount) === 1 ? 0 : undefined);
                if (imgOrd === genOrd) {
                    if (!image.generation) image.generation = { ...generation, turnId: message.id };
                    message.generation = { ...generation, turnId: message.id };
                    return true;
                }
            }
        }
    }

    for (const image of candidateImages) {
        if (image.generation && sameGenerationEvent({ ...image.generation, time: image.generation.time ?? undefined }, { ...generation, time: generation.time ?? undefined })) {
            if (generation.imageOrdinal !== undefined && image.generation.imageOrdinal !== undefined) {
                if (image.generation.imageOrdinal === generation.imageOrdinal) return true;
            } else if (generation.imageCount === 1) {
                return true;
            }
        }
    }

    // Fallback: A single-image event where model message has exactly ONE image explicitly marked isGenerated === true.
    if (generation.imageCount === 1 && genOrd === 0) {
        const explicitlyGen = candidateImages.filter((image) => image.isGenerated === true);
        if (explicitlyGen.length === 1) {
            const target = explicitlyGen[0];
            if (!target.generation) target.generation = { ...generation, turnId: message.id };
            message.generation = { ...generation, turnId: message.id };
            return true;
        }
    }

    return false;
}
