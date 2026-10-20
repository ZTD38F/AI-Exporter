import type {
    Attachment as RepoAttachment,
    ChatMessage as RepoMessage,
} from '../../../../types/conversation.js';
import type { Asset } from '../assets.js';
import { collectReferencedAssetIds } from '../assetReferences.js';
import type { BlockNode } from '../blocks.js';
import type { Citation } from '../citations.js';
import type { MessageNode, MessageRole } from '../conversation.js';
import type { Diagnostic } from '../diagnostics.js';
import type { JsonValue } from '../json.js';
import type { SourceRef } from '../provenance.js';
import { formatUnknownPayload } from '../unknownFallback.js';
import type { InlineByteStore } from '../../assets/index.js';
import {
    buildAsset,
    indexAssetRef,
    mergeMessageAttachments,
    newAssetLinkIndex,
} from './normalizeAssets.js';
import { convertHtmlToMarkdown } from '../../../engine/formatters/htmlConverter.js';
import { stripInternalChipMarkdown } from '../../../utils/chipUtils.js';
import { type MarkdownParseContext, parseMarkdownToBlocks } from '../markdown/index.js';
import {
    extractRawCitations,
    linkCitationMarkers,
} from './normalizeCitations.js';
import { geminiStructuredToCanonical } from './structuredAdapter.js';

export const KNOWN_MESSAGE_FIELDS: ReadonlySet<string> = new Set([
    'id', 'role', 'content', 'timestamp', 'turnId', 'attachments', 'thoughts',
    'thinking', 'citations', 'images', 'documents', 'attachmentCount',
    'messageCount', 'sources', 'structuredContent', 'groundingCitationMarkers',
]);

function isStr(v: unknown): v is string {
    return typeof v === 'string';
}

export function toIso(value: unknown): string | undefined {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'number' && Number.isFinite(value)) {
        const d = new Date(value);
        return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
    }
    if (typeof value === 'string') {
        const s = value.trim();
        if (!s) return undefined;
        if (/^-?\d+$/.test(s)) return toIso(Number(s));
        const t = Date.parse(s);
        return Number.isNaN(t) ? undefined : new Date(t).toISOString();
    }
    return undefined;
}

export function mapRole(role: unknown): { role: MessageRole; rawRole?: string } {
    if (role === 'user') return { role: 'user' };
    if (role === 'model' || role === 'assistant') return { role: 'assistant' };
    if (role === 'system') return { role: 'system' };
    return { role: 'unknown', rawRole: isStr(role) ? role : undefined };
}

export interface MessageBuild {
    node: MessageNode;
    assets: Asset[];
    citations: Citation[];
    diagnostics: Diagnostic[];
}

export function cleanBody(text: unknown): string {
    if (typeof text !== 'string' || !text) return '';
    return stripInternalChipMarkdown(convertHtmlToMarkdown(text));
}

export function normalizeMessage(
    m: RepoMessage,
    index: number,
    locator: string,
    ctx: { providerId: string; diag: Diagnostic[]; byteStore: InlineByteStore },
): MessageBuild {
    const diagnostics: Diagnostic[] = [];
    const msgId = isStr(m.id) && m.id ? m.id : `msg-${index}`;
    if (msgId !== m.id) {
        diagnostics.push({
            id: `synth-id:${msgId}`,
            severity: 'info',
            code: 'SYNTHESIZED_MESSAGE_ID',
            message: `message at ${locator} had no id; assigned deterministic ${msgId}`,
        });
    }
    const sourceRef: SourceRef = {
        providerId: ctx.providerId,
        ...(isStr(m.id) ? { providerMessageId: m.id } : {}),
        locator,
    };
    const { role, rawRole } = mapRole(m.role);
    if (role === 'unknown') {
        diagnostics.push({
            id: `unknown-role:${msgId}`,
            severity: 'info',
            code: 'UNKNOWN_ROLE',
            message: `unrecognized role mapped to 'unknown'`,
            sourceRef,
            details: { rawRole: rawRole ?? null } as JsonValue,
        });
    }

    const idPrefix = msgId;
    let blockSeq = 0;
    const nextBlockId = (): string => `${idPrefix}-b${blockSeq++}`;

    // Index attachments before markdown parsing so inline ![alt](src) nodes can link to their Asset IDs.
    const merged = mergeMessageAttachments(m);
    const attachmentBlocks: BlockNode[] = [];
    const assets: Asset[] = [];
    const assetIndex = newAssetLinkIndex();
    merged.forEach((a, ai) => {
        const assetId = `${msgId}-a${ai}`;
        const built = buildAsset(a, assetId, { ...sourceRef, locator: `${locator}.attachments[${ai}]` }, ctx.byteStore);
        assets.push(built.asset);
        for (const ref of [a.localName, a.url, a.sourceUrl, a.resolvedUrl, a.src]) {
            if (typeof ref === 'string' && ref) {
                indexAssetRef(assetIndex, ref, assetId);
            }
        }
        diagnostics.push(...built.diagnostics);
        const bid = nextBlockId();
        if (built.isImage) {
            attachmentBlocks.push({
                id: bid, type: 'image', assetId,
                alt: built.asset.name,
            });
        } else {
            attachmentBlocks.push({
                id: bid, type: 'file', assetId,
                label: built.asset.name,
            });
        }
    });

    const st: MarkdownParseContext = { diagnostics, sourceRef, assetIndex, inlineAssets: [], idPrefix, byteStore: ctx.byteStore, nextBlockId };
    const blocks: BlockNode[] = [];

    const thoughtsRaw = m.thoughts ?? m.thinking ?? '';
    const thoughtsText = cleanBody(Array.isArray(thoughtsRaw) ? thoughtsRaw.join('\n\n') : thoughtsRaw);
    if (thoughtsText.trim()) {
        blocks.push({
            id: nextBlockId(),
            type: 'thought',
            disclosure: 'providerExposed',
            kind: 'reasoning',
            blocks: parseMarkdownToBlocks(thoughtsText, idPrefix, st),
        });
    }

    let usedStructured = false;
    if (m.structuredContent) {
        const structuredBlocks = geminiStructuredToCanonical(m.structuredContent, idPrefix, st);
        if (structuredBlocks !== null) {
            const rawText = typeof m.content === 'string' ? cleanBody(m.content).trim() : '';
            if (structuredBlocks.length > 0 || !rawText) {
                blocks.push(...structuredBlocks);
                usedStructured = true;
            }
        }
    }

    if (!usedStructured) {
        if (typeof m.content === 'string') {
            const cleaned = cleanBody(m.content);
            if (cleaned.trim()) blocks.push(...parseMarkdownToBlocks(cleaned, idPrefix, st));
        } else if (m.content !== undefined && m.content !== null) {
            const visible = formatUnknownPayload(m.content as JsonValue);
            const ub: BlockNode = {
                id: nextBlockId(),
                type: 'unknown',
                sourceType: 'message-content',
                text: visible.text,
            };
            blocks.push(ub);
            diagnostics.push({
                id: `unknown-content:${msgId}`,
                severity: 'warning',
                code: 'UNKNOWN_MESSAGE_CONTENT',
                message: `message content was not a string; preserved as unknown block`,
                sourceRef,
                details: { truncated: visible.truncated } as JsonValue,
            });
        }
    }

    for (const ia of st.inlineAssets) {
        assets.push(ia);
    }
    const placedAssetIds = collectReferencedAssetIds(blocks);
    for (const block of attachmentBlocks) {
        if (block.type !== 'image' && block.type !== 'file') {
            blocks.push(block);
            continue;
        }
        if (!placedAssetIds.has(block.assetId)) {
            blocks.push(block);
        }
    }

    const citations: Citation[] = [];
    const webCitations: Citation[] = [];
    const { list: rawCits, skipped } = extractRawCitations(m);
    if (skipped > 0) {
        diagnostics.push({
            id: `citation-skipped:${msgId}`,
            severity: 'info',
            code: 'CITATION_SKIPPED',
            message: `${skipped} citation/source entries had no usable URL and were skipped`,
            sourceRef,
        });
    }
    rawCits.forEach((rc, ci) => {
        const cid = `${msgId}-cit${ci}`;
        let kind: Citation['kind'] = 'web';
        if (!rc.url) kind = 'other';
        else if (!/^https?:\/\//i.test(rc.url)) kind = 'other';
        const cit: Citation = {
            id: cid,
            kind,
            url: rc.url,
            title: rc.title,
        };
        citations.push(cit);
        webCitations.push(cit);
    });

    const groundingMap = new Map<string, { citation: Citation; displayLabel: string }>();
    if (Array.isArray(m.groundingCitationMarkers) && m.groundingCitationMarkers.length > 0) {
        for (const rawMarker of m.groundingCitationMarkers) {
            if (typeof rawMarker !== 'string') continue;
            const marker = rawMarker.trim();
            const numMatch = marker.match(/\d+/);
            const n = numMatch ? numMatch[0] : '1';
            const displayLabel = `[${n}]`;
            const cid = `${msgId}-gcit-${n}`;
            let cit = citations.find((c) => c.id === cid);
            if (!cit) {
                cit = {
                    id: cid,
                    kind: 'attachment',
                };
                citations.push(cit);
            }
            groundingMap.set(marker, { citation: cit, displayLabel });
            const normKey = marker.toLowerCase().replace(/\s+/g, ' ');
            if (normKey !== marker) {
                groundingMap.set(normKey, { citation: cit, displayLabel });
            }
        }
    }

    if (webCitations.length > 0 || groundingMap.size > 0) {
        linkCitationMarkers(blocks, webCitations, groundingMap);
    }

    const unknownFields = Object.keys(m ?? {}).filter((k) => !KNOWN_MESSAGE_FIELDS.has(k));
    if (unknownFields.length) {
        diagnostics.push({ id: `unknown-message-fields:${msgId}`, severity: 'info', code: 'UNKNOWN_MESSAGE_FIELDS',
            message: 'unrecognized message fields omitted from the document', sourceRef, details: { fields: unknownFields } });
    }
    const createdAt = toIso(m.timestamp);
    const node: MessageNode = {
        id: msgId,
        role,
        ...(rawRole ? { author: { rawRole } } : {}),
        ...(createdAt ? { createdAt } : {}),
        blocks,
        ...(citations.length ? { citationIds: citations.map((c) => c.id) } : {}),
    };
    return { node, assets, citations, diagnostics };
}
