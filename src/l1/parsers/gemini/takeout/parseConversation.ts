import { contentQuality } from '../../qualityEvidence.js';
import { parseIndexMetadata } from '../../shared/parseIndexMetadata.js';
import { decodeTakeoutHtml, decodeTakeoutHtmlAsync, type TakeoutActivityEvidence } from './decodeHtml.js';
import type { ConversationParseContext } from '../../contracts.js';
import type { DomainMessage } from '../../../../l2/conversationDetail.js';
import type { Diagnostic } from '../../../../shared/diagnostics/diagnostic.js';
import { closeDomainResources } from '../../shared/resources/domainResourceAdapter.js';
import type { ResourceEvidence } from '../../shared/resources/resourceEvidence.js';
import { parseGeminiBody, parseGeminiPrompt } from '../shared/contentAdapter.js';
import type { SourceConversationParseResult } from '../../parsingResult.js';

import { createTakeoutResourceResolver, decodeTakeoutReference, takeoutBaseName, type TakeoutSourceFile } from './archiveResources.js';
export type { TakeoutSourceFile } from './archiveResources.js';

export interface GeminiTakeoutRaw {
    htmlText: string;
    /** Actual HTML entry path, used to resolve relative source references. */
    activityPath?: string;
    archiveFiles?: Readonly<Record<string, TakeoutSourceFile>>;
}
export interface GeminiTakeoutParseContext extends ConversationParseContext { targetConvId?: string }
export interface GeminiTakeoutParseResult extends SourceConversationParseResult {
    archiveResources: Readonly<Record<string, { path: string; entry: TakeoutSourceFile }>>;
}

const isImage = (name: string): boolean => /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(name);

/** One selected source conversation. Multi-conversation archives require explicit selection. */
export function parseGeminiTakeoutConversation(raw: GeminiTakeoutRaw, context: GeminiTakeoutParseContext): GeminiTakeoutParseResult {
    if (context.providerId !== 'gemini') throw new TypeError('Gemini Takeout parser requires providerId gemini');
    const activities = decodeTakeoutHtml(raw.htmlText);
    const ids = [...new Set(activities.flatMap(activity => activity.conversationIds))];
    const id = context.targetConvId?.replace(/^c_/, '') ?? (ids.length === 1 ? ids[0] : undefined);
    if (!id || !ids.includes(id)) throw new TypeError('Takeout requires an existing targetConvId when no single conversation can be selected');
    return buildConversation(id, activities, createTakeoutResourceResolver(raw.archiveFiles ?? {}, raw.activityPath), context);
}

/** Batch decoding shares the same source evidence and per-conversation Domain construction. */
export function parseGeminiTakeoutArchive(raw: GeminiTakeoutRaw, context: ConversationParseContext): GeminiTakeoutParseResult[] {
    if (context.providerId !== 'gemini') throw new TypeError('Gemini Takeout parser requires providerId gemini');
    const activities = decodeTakeoutHtml(raw.htmlText);
    const ids = [...new Set(activities.flatMap(activity => activity.conversationIds))];
    if (!ids.length) throw new TypeError('Takeout has no recognized conversation identities');
    const resolveResource = createTakeoutResourceResolver(raw.archiveFiles ?? {}, raw.activityPath);
    return ids.map(id => buildConversation(id, activities, resolveResource, context));
}

/** Large ZIP inputs yield during decoding and Domain construction without changing semantics. */
export async function parseGeminiTakeoutArchiveAsync(raw: GeminiTakeoutRaw, context: ConversationParseContext, onProgress?: (completed: number, total: number) => void): Promise<GeminiTakeoutParseResult[]> {
    if (context.providerId !== 'gemini') throw new TypeError('Gemini Takeout parser requires providerId gemini');
    const activities = await decodeTakeoutHtmlAsync(raw.htmlText, onProgress);
    const groups = new Map<string, TakeoutActivityEvidence[]>();
    for (const activity of activities) for (const id of activity.conversationIds) {
        const group = groups.get(id) ?? [];
        group.push(activity); groups.set(id, group);
    }
    if (!groups.size) throw new TypeError('Takeout has no recognized conversation identities');
    const resolve = createTakeoutResourceResolver(raw.archiveFiles ?? {}, raw.activityPath);
    const results: GeminiTakeoutParseResult[] = [];
    for (const [id, selected] of groups) {
        results.push(buildConversation(id, selected, resolve, context));
        if (results.length % 50 === 0) await new Promise<void>(resume => setTimeout(resume, 0));
    }
    return results;
}

function buildConversation(id: string, activities: TakeoutActivityEvidence[], resolveResource: ReturnType<typeof createTakeoutResourceResolver>, context: ConversationParseContext): GeminiTakeoutParseResult {
    const diagnostics: Diagnostic[] = [];
    const contentDiagnostics: Diagnostic[] = [];
    const messages: DomainMessage[] = [];
    const groups: Array<{ input: { attachments: ResourceEvidence[] } }> = [];
    const boundFiles = new Map<string, { path: string; entry: TakeoutSourceFile }>();
    const unowned: ResourceEvidence[] = [];
    const attachmentOf = (ref: { uri: string }, generation?: { chatId: string; time?: number; prompt: string; generationOrdinal: number; imageCount: number }): ResourceEvidence => {
        const resolution = resolveResource(ref.uri);
        const match = resolution.status === 'resolved' ? resolution.resource : undefined;
        if (!match) diagnostics.push({ severity: 'warning', code: resolution.status === 'ambiguous' ? 'TAKEOUT_AMBIGUOUS_RESOURCE' : 'TAKEOUT_MISSING_RESOURCE', message: `Archive resource could not be resolved: ${ref.uri}` });
        else if (resolution.status === 'resolved' && ['stem', 'normalized-name', 'normalized-stem'].includes(resolution.method)) diagnostics.push({ severity: 'info', code: 'TAKEOUT_RESOURCE_NAME_FALLBACK', message: `Archive resource resolved by ${resolution.method}: ${ref.uri}` });
        const sourceUrl = match?.path ?? ref.uri;
        if (match) boundFiles.set(sourceUrl, match);
        const size = match?.entry._data?.uncompressedSize;
        const referenceName = decodeTakeoutReference(ref.uri);
        const image = isImage(sourceUrl) || isImage(referenceName);
        const type = image ? 'image' : /\.(wav|mp3|m4a|aac|ogg|flac|opus)$/i.test(referenceName) ? 'audio' : /\.(mp4|webm|mov|mkv)$/i.test(referenceName) ? 'video' : 'file';
        return { type, url: ref.uri, sourceUrl, name: takeoutBaseName(match ? sourceUrl : decodeTakeoutReference(sourceUrl)), source: 'takeout',
            ...(size !== undefined && Number.isFinite(size) && size >= 0 ? { size } : {}),
            ...(generation && image ? { isGenerated: true, generation: { ...generation,
                ...(generation.imageCount === 1 ? { imageOrdinal: 0 } : {}) } } : {}) };
    };
    const selected = activities.filter(activity => activity.conversationIds.includes(id));
    // Source date orders activity events; ties and absent dates retain source order.
    const dated = selected.flatMap(activity => activity.timestamp === null ? [] : [{ activity, timestamp: activity.timestamp }])
        .sort((a, b) => a.timestamp - b.timestamp || a.activity.blockIndex - b.activity.blockIndex).map(item => item.activity);
    let dateIndex = 0;
    const ordered = selected.map(activity => activity.timestamp === null ? activity : dated[dateIndex++]);
    let generationOrdinal = 0;
    for (const activity of ordered) {
        if (activity.conversationIds.length > 1) diagnostics.push({ severity: 'warning', code: 'TAKEOUT_AMBIGUOUS_CONVERSATION', message: 'Activity links multiple conversations; its ownership is ambiguous', path: `blocks[${activity.blockIndex}]` });
        const generation = activity.generatedImageCount !== undefined ? { chatId: id, ...(activity.timestamp !== null ? { time: activity.timestamp } : {}),
            prompt: activity.hasExplicitPrompt ? activity.promptText : '', generationOrdinal: generationOrdinal++, imageCount: activity.generatedImageCount } : undefined;
        // A preview outside the authored cell can repeat an explicitly owned URI.
        // Keep that source resource's known relation instead of reporting a second,
        // unbound copy. Distinct resources outside the cell remain unowned.
        const ownedUris = new Set(activity.media.filter(media => media.owner !== 'unknown').map(media => media.uri));
        for (const ref of activity.media.filter(media => media.owner === 'unknown' && !ownedUris.has(media.uri))) {
            unowned.push(attachmentOf(ref));
            diagnostics.push({ severity: 'warning', code: 'TAKEOUT_UNBOUND_RESOURCE', message: `Source does not identify which message owns archive resource: ${ref.uri}` });
        }
        const roles: DomainMessage['role'][] = ['user', 'assistant'];
        for (const role of roles) {
            const content = role === 'user' ? (activity.hasExplicitPrompt ? activity.promptText : '') : activity.responseHtml;
            const references = activity.media.filter(media => media.owner === role);
            if (!content && !references.length) {
                if (role === 'assistant' && generation) diagnostics.push({ severity: 'info', code: 'TAKEOUT_GENERATED_MEDIA_UNRESOLVED', message: 'Source generation activity has no authored content or resource' });
                continue;
            }
            const attachments = references.map(ref => attachmentOf(ref, role === 'assistant' ? generation : undefined));
            messages.push({ role, content: role === 'user'
                ? parseGeminiPrompt(content)
                : parseGeminiBody(content, undefined, { diagnostics: contentDiagnostics,
                    sourceRef: { providerId: 'gemini', locator: `blocks[${activity.blockIndex}].${role}` } }),
                ...(activity.timestamp !== null ? { timestamp: activity.timestamp } : {}) });
            groups.push({ input: { attachments } });
            if (role === 'assistant' && generation && !attachments.some(a => a.isGenerated)) diagnostics.push({ severity: 'warning', code: 'TAKEOUT_GENERATED_MEDIA_UNRESOLVED', message: 'Activity records image generation without an explicit archive resource reference' });
        }
    }
    if (unowned.length) groups.push({ input: { attachments: unowned } });
    const resources = closeDomainResources('gemini', messages, groups, { sourceReferences: true });
    const dates = selected.flatMap(activity => activity.timestamp === null ? [] : [activity.timestamp]);
    const activityAt = dates.length ? Math.max(...dates) : null;
    const titleEvent = selected.find(a => a.hasExplicitPrompt && a.promptText)
        ?? selected.find(a => a.promptText && !/^(?:Takeout conversation|Untitled.*)$/i.test(a.promptText.trim()))
        ?? selected.find(a => a.promptText);
    const title = titleEvent?.promptText.split('\n')[0].slice(0, 80).trim() || '';
    const conversation = {
        index: parseIndexMetadata({ providerId: 'gemini', id, title, titleSource: 'takeout',
            ...(activityAt !== null ? { activityAt } : {}), messageCount: resources.messages.length,
            url: `https://gemini.google.com/app/${id}` }, 'takeout'),
        detail: { quality: contentQuality({ status: 'partial', heuristicDocumentIds: resources.heuristicDocumentIds }), assets: resources.assets, messages: resources.messages },
    };
    const archiveResources: Record<string, { path: string; entry: TakeoutSourceFile }> = {};
    for (const asset of resources.assets) {
        const bound = asset.sourceUri ? boundFiles.get(asset.sourceUri) : undefined;
        if (bound) archiveResources[asset.id] = bound;
    }
    return { evidence: { heuristicDocumentIds: resources.heuristicDocumentIds }, conversationId: id, conversation, acquisitionHints: resources.acquisitionHints, archiveResources,
        diagnostics: [...diagnostics, ...contentDiagnostics] };
}
