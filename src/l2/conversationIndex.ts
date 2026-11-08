import { resolveTitle, isTitleSource, type TitleSource } from './titleAuthority.js';
import { readConversationKey, sameConversationKey, type ConversationKey } from './conversationKey.js';

export interface DomainConversationIndex {
    key: ConversationKey;
    title?: string;
    titleSource?: TitleSource;
    createdAt?: number;
    updatedAt?: number;
    /** Source activity date for presentation; never an online content version. */
    activityAt?: number;
}

/** Public schema name from the frozen L2 interface contract. */
export type ConversationIndex = DomainConversationIndex;
export type ConversationIndexPatch = Partial<Omit<DomainConversationIndex, 'key'>>;
const keys = new Set(['key', 'title', 'titleSource', 'createdAt', 'updatedAt', 'activityAt']);
/** Index persistence/IPC ingress: validate unknown timestamps before constructing typed facts. */
function readOptionalIndexTime(value: unknown): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TypeError('Invalid conversation index schema');
    return value;
}
export function restoreConversationIndex(value: unknown): DomainConversationIndex {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid conversation index');
    const key = readConversationKey('key' in value ? value.key : undefined);
    const title = 'title' in value ? value.title : undefined;
    const titleSource = 'titleSource' in value ? value.titleSource : undefined;
    if (Object.keys(value).some(k => !keys.has(k))) throw new TypeError('Invalid conversation index schema');

    let titleFields: { title: string; titleSource: TitleSource } | undefined;
    if (title !== undefined || titleSource !== undefined) {
        if (typeof title !== 'string' || !title || title !== title.trim()
            || typeof titleSource !== 'string' || !isTitleSource(titleSource)) throw new TypeError('Invalid conversation index schema');
        titleFields = { title, titleSource };
    }
    const createdAt = readOptionalIndexTime('createdAt' in value ? value.createdAt : undefined);
    const updatedAt = readOptionalIndexTime('updatedAt' in value ? value.updatedAt : undefined);
    const activityAt = readOptionalIndexTime('activityAt' in value ? value.activityAt : undefined);
    return { key, ...(titleFields ?? {}),
        ...(createdAt !== undefined ? { createdAt } : {}),
        ...(updatedAt !== undefined ? { updatedAt } : {}),
        ...(activityAt !== undefined ? { activityAt } : {}) };
}

/** Missing facts preserve values. At the same title authority, the latest admission wins. */
export function mergeConversationIndex(old: DomainConversationIndex | undefined, incoming: DomainConversationIndex): DomainConversationIndex {
    if (!old) return restoreConversationIndex(incoming);
    if (!sameConversationKey(old.key, incoming.key)) throw new TypeError('Conversation index identity mismatch');
    const chosen = resolveTitle([old, incoming].flatMap(index => index.title && index.titleSource
        ? [{ value: index.title, source: index.titleSource }] : []));
    const createdAt = old.createdAt === undefined ? incoming.createdAt : incoming.createdAt === undefined ? old.createdAt : Math.min(old.createdAt, incoming.createdAt);
    const updatedAt = old.updatedAt === undefined ? incoming.updatedAt : incoming.updatedAt === undefined ? old.updatedAt : Math.max(old.updatedAt, incoming.updatedAt);
    const activityAt = old.activityAt === undefined ? incoming.activityAt : incoming.activityAt === undefined ? old.activityAt : Math.max(old.activityAt, incoming.activityAt);
    return { key: { ...old.key }, ...(chosen ? { title: chosen.value, titleSource: chosen.source } : {}),
        ...(createdAt !== undefined ? { createdAt } : {}), ...(updatedAt !== undefined ? { updatedAt } : {}), ...(activityAt !== undefined ? { activityAt } : {}) };
}
export function indexActivityTime(index: Pick<DomainConversationIndex, 'updatedAt' | 'activityAt'>): number | undefined {
    return index.updatedAt === undefined ? index.activityAt : index.activityAt === undefined ? index.updatedAt : Math.max(index.updatedAt, index.activityAt);
}
export function compareConversationIndexes(a: DomainConversationIndex, b: DomainConversationIndex): number {
    const left = indexActivityTime(a), right = indexActivityTime(b);
    if (left === undefined) return right === undefined ? 0 : 1;
    return right === undefined ? -1 : right - left;
}
