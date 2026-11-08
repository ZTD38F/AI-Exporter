import { parseConversationRecord } from './parseRecord.js';
import type { ConversationRecordInput } from './conversationRecord.js';
import type { DomainFixture } from '../domainFixture.js';
import type { ConversationRecordParseContext } from './parseRecord.js';
import { normId } from '../../../src/shared/utils/pathUtils.js';

interface LegacyStorageRaw { metadata: unknown; detail?: unknown }
function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid legacy storage record');
    return value as Record<string, unknown>;
}
function length(value: Record<string, unknown>): number { return Math.max(Array.isArray(value.messages) ? value.messages.length : 0, Array.isArray(value.turns) ? value.turns.length : 0); }

/** The old disk schema is a source format. It never writes storage or synthesizes raw RPC. */
export function parseLegacyStorageConversation(raw: LegacyStorageRaw, context: ConversationRecordParseContext): DomainFixture {
    const metadata = record(raw.metadata);
    if (typeof metadata.id !== 'string' && typeof metadata.id !== 'number') throw new TypeError('Legacy stored conversation has no identity');
    const id = context.providerId === 'gemini' ? normId(String(metadata.id)) : String(metadata.id);
    if (!id) throw new TypeError('Legacy stored conversation has no identity');
    const detail = raw.detail === undefined || raw.detail === null ? undefined : record(raw.detail);
    if (detail?.id !== undefined && (context.providerId === 'gemini' ? normId(String(detail.id)) : String(detail.id)) !== id) throw new TypeError('Legacy metadata/detail identity mismatch');
    const body = detail && length(detail) > length(metadata) ? detail : metadata;
    // Required container checks do not silently discard malformed historical body data.
    for (const key of ['messages', 'turns']) if (body[key] !== undefined && !Array.isArray(body[key])) throw new TypeError(`Invalid legacy ${key}`);
    const input = { ...metadata, id, messages: body.messages, turns: body.turns } as ConversationRecordInput;
    // v1 metadata describes the latest listing, not the version of its cached body.
    // Its local savedAt clock cannot establish that source version.
    delete input.updatedAt;
    const missingBody = !length(body) && Number(metadata.messageCount) > 0;
    const parsed = parseConversationRecord(input, { ...context,
        qualityStatusOverride: context.qualityStatusOverride ?? (missingBody
            ? 'partial' : undefined) });
    if (missingBody) {
        parsed.diagnostics.push({ severity: 'warning', code: 'LEGACY_BODY_NOT_STORED', message: 'Conversation body is absent from legacy storage' });
    }
    return parsed;
}
