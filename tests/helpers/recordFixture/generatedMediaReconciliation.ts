import type { GeneratedMediaIdentity } from '../historicalConversation.js';
import { findGenerationModelMessage, hasGenerationImage, type GenerationMessage } from './generationIdentity.js';

function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isGeneratedMediaIdentity(value: unknown): value is GeneratedMediaIdentity {
    return isObjectRecord(value) && typeof value.chatId === 'string' && typeof value.generationOrdinal === 'number'
        && ['providerRequestId', 'prompt', 'turnId'].every(key => value[key] === undefined || typeof value[key] === 'string')
        && ['imageCount', 'imageOrdinal'].every(key => value[key] === undefined || typeof value[key] === 'number')
        && (value.time === undefined || value.time === null || typeof value.time === 'number');
}

/** Legacy acquisition compatibility: resolve media while raw provider evidence is still available. */
export function supplementLegacyGeneratedMedia(
    chat: { id?: string; messages?: GenerationMessage[] | null },
    nid: string,
    takeoutMedia: readonly unknown[],
    options: { appendMarkdownRef?: boolean } = {},
): void {
    if (!Array.isArray(chat.messages)) return;
    const appendMarkdownRef = options.appendMarkdownRef ?? true;
    for (const tm of takeoutMedia) {
        if (!isObjectRecord(tm) || !tm.isGenerated || typeof tm.filename !== 'string') continue;
        const tmFilename = tm.filename;
        const tmRequestId = typeof tm.providerRequestId === 'string' ? tm.providerRequestId : undefined;
        const tmImageOrdinal = typeof tm.imageOrdinal === 'number' ? tm.imageOrdinal : undefined;
        const generation: GeneratedMediaIdentity | null = isGeneratedMediaIdentity(tm.generation)
            ? tm.generation
            : (tmRequestId ? {
                chatId: nid,
                providerRequestId: tmRequestId,
                generationOrdinal: 0,
                imageOrdinal: tmImageOrdinal,
            } : null);
        const eventTarget = generation
            ? findGenerationModelMessage({ id: typeof chat.id === 'string' ? chat.id : undefined, messages: chat.messages }, generation)
            : null;
        if (eventTarget && generation && hasGenerationImage(eventTarget, generation)) continue;
        const candidates: GenerationMessage[] = generation ? (eventTarget ? [eventTarget] : []) : chat.messages;
        const alreadyHas = candidates.some((m: GenerationMessage) =>
            (m.images && m.images.some((im) => im.fileName === tmFilename || (im.localName && im.localName.includes(tmFilename)))) ||
            (m.attachments && m.attachments.some((at) => at.fileName === tmFilename || (at.localName && at.localName.includes(tmFilename)))) ||
            (typeof m.content === 'string' && m.content.includes(tmFilename))
        );
        if (!alreadyHas) {
            const imgObj = {
                type: 'image',
                url: tmFilename,
                name: tmFilename,
                fileName: tmFilename,
                localName: `assets/${tmFilename}`,
                source: 'takeout',
                isGenerated: true,
                providerRequestId: tmRequestId || generation?.providerRequestId,
                imageOrdinal: tmImageOrdinal ?? generation?.imageOrdinal,
                ...(generation ? { generation } : {})
            };
            const targetModelMsg = eventTarget;
            if (targetModelMsg) {
                targetModelMsg.images = targetModelMsg.images || [];
                targetModelMsg.attachments = targetModelMsg.attachments || [];
                targetModelMsg.images.push(imgObj);
                targetModelMsg.attachments.push(imgObj);
                if (appendMarkdownRef) {
                    const currentContent = typeof targetModelMsg.content === 'string' ? targetModelMsg.content : '';
                    if (!currentContent.includes(tmFilename)) {
                        targetModelMsg.content = (currentContent ? currentContent + '\n\n' : '') + `![Generated Image](assets/${tmFilename})`;
                    }
                }
            } else {
                chat.messages.push({
                    role: 'model',
                    content: appendMarkdownRef ? `![Generated Image](assets/${tmFilename})` : '',
                    timestamp: generation?.time ?? null,
                    providerRequestId: tmRequestId || generation?.providerRequestId,
                    ...(generation ? { generation } : {}),
                    images: [imgObj],
                    attachments: [imgObj]
                });
            }
        }
    }
}
