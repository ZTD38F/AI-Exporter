import type { Diagnostic } from '../../../../shared/diagnostics/diagnostic.js';
import { contentQuality } from '../../qualityEvidence.js';
import type { DomainAsset, DomainMessage } from '../../../../l2/conversationDetail.js';
import { mapContentAssetReferences } from '../../../../l2/content/assetReferences.js';
import type { SourceConversationParseResult } from '../../parsingResult.js';

type ConversationPage = SourceConversationParseResult;

/** Pages arrive newest first. Asset collisions without shared source identity remain distinct. */
export function mergeConversationPages(pages: readonly ConversationPage[], truncatedReason?: string, coverageComplete = false): SourceConversationParseResult {
    if (!pages.length) throw new TypeError('No conversation pages');
    const first = pages[0].conversation;
    const assets = new Map<string, DomainAsset>();
    const heuristicDocumentIds: string[] = [];
    const seenMessages = new Set<string>();
    let messages: DomainMessage[] = [];
    const acquisitionHints: Record<string, SourceConversationParseResult['acquisitionHints'][string]> = {};
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
        const page = pages[pageIndex];
        if (page.conversationId !== pages[0].conversationId) throw new TypeError('Cannot merge pages from different conversations');
        const aliases = new Map<string, string>();
        for (const asset of page.conversation.detail.assets) {
            let id = asset.id;
            const previous = assets.get(id);
            const sharedSource = previous?.sourceUri && previous.sourceUri === asset.sourceUri && previous.kind === asset.kind;
            if (previous && !sharedSource) {
                id = `${asset.id}_page${pageIndex}`;
                while (assets.has(id)) id += '_';
            }
            aliases.set(asset.id, id);
            assets.set(id, sharedSource ? { ...asset, ...previous } : { ...asset, id });
            if (page.acquisitionHints[asset.id]) acquisitionHints[id] = { ...page.acquisitionHints[asset.id], ...acquisitionHints[id] };
        }
        heuristicDocumentIds.push(...(page.evidence?.heuristicDocumentIds ?? []).map(id => aliases.get(id) ?? id));
        const fresh = page.conversation.detail.messages.filter(message => {
            if (!message.id) return true;
            if (seenMessages.has(message.id)) return false;
            seenMessages.add(message.id); return true;
        }).map(message => ({ ...message,
            content: mapContentAssetReferences(message.content, id => aliases.get(id) ?? id),
            ...(message.reasoning ? { reasoning: mapContentAssetReferences(message.reasoning, id => aliases.get(id) ?? id) } : {}),
            ...(message.attachmentIds ? { attachmentIds: [...new Set(message.attachmentIds.map(id => aliases.get(id) ?? id))] } : {}) }));
        messages = [...fresh, ...messages];
    }
    const rejectedTurns = pages.reduce((sum, page) => sum + (page.evidence?.rejectedTurns ?? 0), 0);
    const versionMismatch = pages.some(page => {
        const version = page.sourceVersion;
        return version !== undefined && page.conversation.detail.messages.some(message => message.timestamp !== undefined && message.timestamp > version);
    });
    const versionChanged = pages.some(page => page.sourceVersion !== pages[0].sourceVersion);
    const truncation = truncatedReason ?? pages.map(page => page.evidence?.truncation).find(reason => reason && reason !== 'pagination_pending');
    const sourcePartial = pages.some(page => page.conversation.detail.quality.status === 'partial' && page.evidence?.truncation !== 'pagination_pending');
    const sourceVersion = versionChanged ? undefined : pages[0].sourceVersion;
    const conversation = { index: first.index, detail: { ...(sourceVersion !== undefined ? { savedAt: sourceVersion } : {}), messages, assets: [...assets.values()],
        quality: contentQuality({ status: sourcePartial || versionChanged ? 'partial' : coverageComplete ? 'complete' : 'unknown', rejectedTurns, truncation, heuristicDocumentIds }) } };
    const warnings: Diagnostic[] = [];
    if (truncatedReason) warnings.push({ severity: 'warning', code: 'GEMINI_PAGINATION_TRUNCATED', message: truncatedReason });
    if (versionChanged) warnings.push({ severity: 'warning', code: 'CONVERSATION_VERSION_CHANGED', message: 'Conversation version changed or became unknown during pagination' });
    return { conversationId: pages[0].conversationId, evidence: { rejectedTurns, truncation, heuristicDocumentIds: [...new Set(heuristicDocumentIds)] }, ...(sourceVersion !== undefined ? { sourceVersion } : {}), conversation, acquisitionHints, diagnostics: [...pages.flatMap(page => page.diagnostics),
        { severity: 'info', code: 'GEMINI_DETAIL_PAGES', message: 'Source Detail pagination evidence', details: {
            pageCount: pages.length, coverageComplete, truncation: truncation ?? null,
            sourcePartial, versionMismatch, versionChanged,
            pages: pages.map((page, index) => {
                const timestamps = page.conversation.detail.messages.flatMap(message => message.timestamp !== undefined ? [message.timestamp] : []);
                return { page: index + 1, sourceVersion: page.sourceVersion ?? null,
                    quality: page.conversation.detail.quality.status, messageCount: page.conversation.detail.messages.length,
                    earliestMessageAt: timestamps.length ? Math.min(...timestamps) : null,
                    latestMessageAt: timestamps.length ? Math.max(...timestamps) : null,
                    rejectedTurns: page.evidence?.rejectedTurns ?? 0,
                    truncation: page.evidence?.truncation ?? null,
                    heuristicDocumentIds: page.evidence?.heuristicDocumentIds ?? [],
                    diagnosticCodes: page.diagnostics.map(diagnostic => diagnostic.code) };
            }) } },
        ...warnings] };
}
