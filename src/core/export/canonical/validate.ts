import type { Asset } from './assets.js';
import type { BlockNode } from './blocks.js';
import type { CanonicalConversationBundle, Conversation } from './conversation.js';
import type { Diagnostic, DiagnosticSeverity } from './diagnostics.js';
import type { InlineNode } from './inline.js';

export interface CanonicalValidationOptions {
    maxMessages?: number;
    maxBlocks?: number;
    maxStringLength?: number;
    maxJsonDepth?: number;
    knownByteAssetIds?: Set<string>;
}

export const CANONICAL_VALIDATION_LIMITS = {
    maxMessages: 100000,
    maxBlocks: 1000000,
    maxStringLength: 10 * 1024 * 1024,
    maxJsonDepth: 32,
} as const;

const URL_ALLOWLIST = new Set(['http:', 'https:', 'blob:', 'data:']);

const BANNED_RENDERER_KEYS = new Set([
    'typst', 'html', 'className', 'style', 'plainText', 'bubbleWidth', 'radius',
    'padding', 'shadow', 'elevation', 'sticky', 'keepWithNext', 'pageBreak', 'syntaxTheme',
    'initiallyCollapsed',
]);

class Collector {
    diagnostics: Diagnostic[] = [];
    private counters = new Map<string, number>();
    add(severity: DiagnosticSeverity, code: string, message: string, path?: string, details?: Diagnostic['details']): void {
        const n = (this.counters.get(code) ?? 0) + 1;
        this.counters.set(code, n);
        this.diagnostics.push({ id: `${code.toLowerCase()}:${n}`, severity, code, message, path, details });
    }
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkUrl(value: unknown, c: Collector, path: string): void {
    if (value === undefined || value === null) return;
    if (typeof value !== 'string' || !value) {
        c.add('warning', 'URL_EMPTY', `empty URL at ${path}`, path);
        return;
    }
    let protocol = '';
    try {
        protocol = new URL(value, 'https://placeholder.invalid').protocol;
        // Relative URLs parse against the placeholder; treat them as https.
        if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) protocol = 'https:';
    } catch {
        c.add('error', 'URL_MALFORMED', `malformed URL at ${path}`, path, { value: value.slice(0, 200) });
        return;
    }
    if (!URL_ALLOWLIST.has(protocol)) {
        c.add('error', 'URL_UNSAFE_PROTOCOL', `disallowed URL protocol '${protocol}' at ${path}`, path, { value: value.slice(0, 200) });
    }
}

function checkStorageRef(value: unknown, c: Collector, path: string): void {
    if (value === undefined || value === null) return;
    if (typeof value !== 'string' || !value) {
        c.add('warning', 'STORAGE_REF_EMPTY', `empty storageRef at ${path}`, path);
        return;
    }
    const bad =
        value.includes('..') ||
        value.startsWith('/') ||
        value.includes('\\') ||
        /^[a-zA-Z]:/.test(value) ||
        value.includes('\0');
    if (bad) {
        c.add('error', 'ASSET_UNSAFE_PATH', `unsafe storageRef at ${path} (must be archive-local)`, path, { value: value.slice(0, 200) });
    }
}

function checkTimestamp(value: unknown, c: Collector, path: string): void {
    if (value === undefined || value === null) return;
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
        c.add('warning', 'TIME_INVALID', `unparseable timestamp at ${path}; unknown times must stay absent`, path);
    }
}

function jsonDepth(v: unknown, depth: number): number {
    if (Array.isArray(v)) return 1 + Math.max(0, ...v.map((x) => jsonDepth(x, depth + 1)));
    if (isRecord(v)) {
        const vals = Object.values(v);
        return 1 + (vals.length ? Math.max(...vals.map((x) => jsonDepth(x, depth + 1))) : 0);
    }
    return depth;
}

function scanBannedKeys(v: unknown, c: Collector, path: string): void {
    if (Array.isArray(v)) {
        v.forEach((x, i) => scanBannedKeys(x, c, `${path}[${i}]`));
        return;
    }
    if (isRecord(v)) {
        for (const [k, val] of Object.entries(v)) {
            if (BANNED_RENDERER_KEYS.has(k)) {
                c.add('warning', 'RENDERER_KEY_LEAK', `renderer-only key '${k}' in canonical data at ${path}`, path);
            }
            scanBannedKeys(val, c, path ? `${path}.${k}` : k);
        }
    }
}

function walkInlineBlocks(blocks: BlockNode[], visit: (b: BlockNode, path: string) => void, basePath: string): number {
    let count = 0;
    const visitBlock = (b: BlockNode, path: string): void => {
        count += 1;
        visit(b, path);
        const kids: Array<{ blocks: BlockNode[]; at: string }> = [];
        if (b.type === 'list') b.items?.forEach((it, i) => kids.push({ blocks: it.blocks ?? [], at: `${path}.items[${i}]` }));
        if (b.type === 'quote' || b.type === 'thought') kids.push({ blocks: b.blocks ?? [], at: path });
        for (const k of kids) {
            k.blocks.forEach((child, i) => visitBlock(child, `${k.at}[${i}]`));
        }
    };
    blocks.forEach((b, i) => visitBlock(b, `${basePath}[${i}]`));
    return count;
}

function walkInlines(inlines: InlineNode[], visit: (n: InlineNode, path: string) => void, basePath: string): void {
    const visitInline = (n: InlineNode, path: string): void => {
        visit(n, path);
        const childrenOf = (node: InlineNode): InlineNode[] => {
            if (node.type === 'strong' || node.type === 'emphasis' || node.type === 'strikethrough' || node.type === 'link') {
                return node.children ?? [];
            }
            return [];
        };
        childrenOf(n).forEach((child, i) => visitInline(child, `${path}.children[${i}]`));
    };
    inlines.forEach((n, i) => visitInline(n, `${basePath}[${i}]`));
}

function inlineHosts(block: BlockNode): Array<{ inlines: InlineNode[]; at: string }> {
    const out: Array<{ inlines: InlineNode[]; at: string }> = [];
    if (block.type === 'paragraph' || block.type === 'heading') out.push({ inlines: block.children ?? [], at: 'children' });
    if (block.type === 'table') {
        const rows = [...(block.headerRows ?? []), ...(block.rows ?? [])];
        rows.forEach((r, ri) => r.cells?.forEach((cell, ci) => out.push({ inlines: cell.children ?? [], at: `row[${ri}].cell[${ci}]` })));
        if (block.caption) out.push({ inlines: block.caption, at: 'caption' });
    }
    if (block.type === 'image' && block.caption) out.push({ inlines: block.caption, at: 'caption' });
    if (block.type === 'file' && block.description) out.push({ inlines: block.description, at: 'description' });
    return out;
}

export function validateBundle(bundle: unknown, options: CanonicalValidationOptions = {}): Diagnostic[] {
    const c = new Collector();
    const limits = {
        maxMessages: options.maxMessages ?? CANONICAL_VALIDATION_LIMITS.maxMessages,
        maxBlocks: options.maxBlocks ?? CANONICAL_VALIDATION_LIMITS.maxBlocks,
        maxStringLength: options.maxStringLength ?? CANONICAL_VALIDATION_LIMITS.maxStringLength,
        maxJsonDepth: options.maxJsonDepth ?? CANONICAL_VALIDATION_LIMITS.maxJsonDepth,
    };

    if (!isRecord(bundle)) {
        c.add('error', 'BUNDLE_SHAPE', 'bundle must be an object');
        return c.diagnostics;
    }
    if ((bundle as Record<string, unknown>).schemaVersion !== 1) {
        c.add('error', 'SCHEMA_VERSION', 'schemaVersion must be 1');
    }
    const conversation = (bundle as Record<string, unknown>).conversation as Conversation | undefined;
    if (!isRecord(conversation)) {
        c.add('error', 'BUNDLE_SHAPE', 'bundle.conversation must be an object');
        return c.diagnostics;
    }
    const assets = Array.isArray((bundle as Record<string, unknown>).assets)
        ? ((bundle as Record<string, unknown>).assets as Asset[]) : [];
    const citations = Array.isArray((bundle as Record<string, unknown>).citations)
        ? ((bundle as Record<string, unknown>).citations as Array<{ id: string; url?: string }>) : [];

    const key = conversation.key as unknown as Record<string, unknown> | undefined;
    if (!isRecord(key) || typeof key.providerId !== 'string' || !key.providerId) {
        c.add('error', 'KEY_BAD', 'conversation.key.providerId must be a non-empty string');
    }
    if (!isRecord(key) || typeof key.conversationId !== 'string' || !key.conversationId) {
        c.add('error', 'KEY_BAD', 'conversation.key.conversationId must be a non-empty string');
    }
    if (!isRecord(key) || typeof key.accountId !== 'string' || !key.accountId) {
        c.add('warning', 'ACCOUNT_ID_PENDING_F1', 'conversation.key.accountId is missing; F1 composite-identity migration owns this value -- never synthesize one');
    }

    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    if (!Array.isArray(conversation.messages)) {
        c.add('error', 'BUNDLE_SHAPE', 'conversation.messages must be an array');
    } else if (messages.length > limits.maxMessages) {
        c.add('error', 'LIMIT_MESSAGES', `message count ${messages.length} exceeds limit ${limits.maxMessages}`);
    }
    const messageIds = new Set<string>();
    for (const m of messages) {
        if (!m || typeof m.id !== 'string' || !m.id) {
            c.add('error', 'MSG_BAD_ID', 'message has a missing or non-string id');
            continue;
        }
        if (messageIds.has(m.id)) c.add('error', 'MSG_DUP_ID', `duplicate message id: ${m.id}`);
        messageIds.add(m.id);
    }
    checkTimestamp(conversation.createdAt, c, 'conversation.createdAt');
    checkTimestamp(conversation.updatedAt, c, 'conversation.updatedAt');

    const title = (conversation as Record<string, unknown>).title;
    if (title !== undefined && (typeof title !== 'string' || !title.trim())) {
        c.add('error', 'TITLE_INVALID', 'conversation.title must be a non-empty string', 'conversation.title');
    }
    const url = (conversation as Record<string, unknown>).url;
    if (url !== undefined) {
        if (typeof url !== 'string' || !url.trim()) {
            c.add('error', 'URL_MALFORMED', 'conversation.url must be a non-empty URL string', 'conversation.url');
        } else {
            try {
                new URL(url);
                checkUrl(url, c, 'conversation.url');
            } catch {
                c.add('error', 'URL_MALFORMED', 'conversation.url must be a valid URL', 'conversation.url');
            }
        }
    }

    const assetIds = new Set<string>();
    for (const a of assets) {
        if (!a || typeof a.id !== 'string' || !a.id) {
            c.add('error', 'ASSET_BAD_ID', 'asset has a missing or non-string id');
            continue;
        }
        if (assetIds.has(a.id)) c.add('error', 'ASSET_DUP_ID', `duplicate asset id: ${a.id}`);
        assetIds.add(a.id);
        checkStorageRef(a.storageRef, c, `assets[${a.id}].storageRef`);
        checkUrl(a.sourceUrl, c, `assets[${a.id}].sourceUrl`);
        if (a.status === 'available' && !a.storageRef && !(options.knownByteAssetIds?.has(a.id))) {
            c.add('warning', 'PSEUDO_AVAILABLE', `asset ${a.id} is marked 'available' with no storageRef or known bytes; export must resolve bytes before treating it as available`, `assets[${a.id}]`);
        }
        if ((a.status === 'missing' || a.status === 'failed') && !a.failureReason) {
            c.add('warning', 'ASSET_NO_REASON', `asset ${a.id} has status '${a.status}' but no failureReason`, `assets[${a.id}]`);
        }
    }
    const citationIds = new Set<string>();
    for (const cit of citations) {
        if (!cit || typeof cit.id !== 'string' || !cit.id) {
            c.add('error', 'CITATION_BAD_ID', 'citation has a missing or non-string id');
            continue;
        }
        if (citationIds.has(cit.id)) c.add('error', 'CITATION_DUP_ID', `duplicate citation id: ${cit.id}`);
        citationIds.add(cit.id);
        checkUrl(cit.url, c, `citations[${cit.id}].url`);
    }

    const blockIds = new Set<string>();
    let totalBlocks = 0;
    messages.forEach((m, mi) => {
        const base = `conversation.messages[${mi}]`;
        if (!m || typeof m.id !== 'string') return;
        checkTimestamp(m.createdAt, c, `${base}.createdAt`);
        if (Array.isArray(m.citationIds)) {
            m.citationIds.forEach((cid: unknown, cidx: number) => {
                if (typeof cid !== 'string' || !citationIds.has(cid)) {
                    c.add('error', 'CITATION_UNRESOLVED', `message citationIds references unknown citation ${cid}`, `${base}.citationIds[${cidx}]`);
                }
            });
        }
        const count = walkInlineBlocks(m.blocks ?? [], (b, path) => {
            if (!b || typeof b.id !== 'string' || !b.id) {
                c.add('error', 'BLOCK_BAD_ID', `block has a missing or non-string id at ${base}.${path}`, `${base}.${path}`);
                return;
            }
            if (blockIds.has(b.id)) c.add('error', 'BLOCK_DUP_ID', `duplicate block id: ${b.id}`, `${base}.${path}`);
            blockIds.add(b.id);
            for (const host of inlineHosts(b)) {
                walkInlines(host.inlines, (n, ipath) => {
                    const full = `${base}.${path}.${host.at}${ipath}`;
                    if (n.type === 'link') checkUrl(n.href, c, full);
                    if (n.type === 'inlineMath' && !n.source) {
                        c.add('warning', 'MATH_NO_SOURCE', 'inlineMath node without source; original LaTeX source must be preserved', full);
                    }
                    if (n.type === 'citationRef' && !citationIds.has(n.citationId)) {
                        c.add('error', 'CITATION_UNRESOLVED', `citationRef to unknown citation ${n.citationId}`, full);
                    }
                    if (n.type === 'image' && !assetIds.has(n.assetId)) {
                        c.add('error', 'ASSET_UNRESOLVED', `inline image references unknown asset ${n.assetId}`, full);
                    }
                }, '');
            }
            if ((b.type === 'image' || b.type === 'file') && !assetIds.has(b.assetId)) {
                c.add('error', 'ASSET_UNRESOLVED', `${b.type} block references unknown asset ${b.assetId}`, `${base}.${path}`);
            }
            if (b.type === 'math' && !b.source) {
                c.add('warning', 'MATH_NO_SOURCE', 'math node without source; original LaTeX source must be preserved', `${base}.${path}`);
            }
            if (b.type === 'unknown') {
                if (typeof b.sourceType !== 'string' || !b.sourceType.trim()) {
                    c.add('error', 'UNKNOWN_BAD_SOURCE_TYPE', 'unknown block sourceType must be non-empty', `${base}.${path}`);
                }
                if (typeof b.text !== 'string' || !b.text.trim()) {
                    c.add('error', 'UNKNOWN_EMPTY', 'unknown block text must be non-empty', `${base}.${path}`);
                }
            }
        }, `${base}.blocks`);
        totalBlocks += count;
    });
    if (totalBlocks > limits.maxBlocks) {
        c.add('error', 'LIMIT_BLOCKS', `block count ${totalBlocks} exceeds limit ${limits.maxBlocks}`);
    }

    let longest = 0;
    const scanStrings = (v: unknown): void => {
        if (typeof v === 'string') {
            if (v.length > longest) longest = v.length;
            return;
        }
        if (Array.isArray(v)) { v.forEach(scanStrings); return; }
        if (isRecord(v)) { Object.values(v).forEach(scanStrings); }
    };
    scanStrings(bundle);
    if (longest > limits.maxStringLength) {
        c.add('error', 'LIMIT_STRING', `longest string ${longest} chars exceeds limit ${limits.maxStringLength}`);
    }
    if (jsonDepth(bundle, 0) > limits.maxJsonDepth) {
        c.add('error', 'LIMIT_DEPTH', `JSON depth exceeds limit ${limits.maxJsonDepth}`);
    }
    scanBannedKeys(bundle, c, '');

    return c.diagnostics;
}
