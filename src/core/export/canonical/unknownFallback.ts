import type { BlockNode } from './blocks.js';
import type { InlineNode } from './inline.js';
import type { JsonValue } from './json.js';

export interface TextExtractOptions {
    citationLabel?: (citationId: string) => string | undefined;
}

const UNKNOWN_PAYLOAD_MAX_DEPTH = 4;
const UNKNOWN_PAYLOAD_MAX_LENGTH = 2000;

function stringifyLimited(value: JsonValue, depth: number): string {
    if (value === null) return 'null';
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (depth >= UNKNOWN_PAYLOAD_MAX_DEPTH) return Array.isArray(value) ? '[…]' : '{…}';
    if (Array.isArray(value)) {
        return `[${value.map((v) => stringifyLimited(v as JsonValue, depth + 1)).join(', ')}]`;
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}: ${stringifyLimited((value as Record<string, JsonValue>)[k], depth + 1)}`).join(', ')}}`;
}

export function formatUnknownPayload(payload: JsonValue): { text: string; truncated: boolean } {
    let text: string;
    try {
        text = stringifyLimited(payload, 0);
    } catch {
        text = '[unprintable payload]';
    }
    if (text.length > UNKNOWN_PAYLOAD_MAX_LENGTH) {
        return { text: text.slice(0, UNKNOWN_PAYLOAD_MAX_LENGTH) + '…', truncated: true };
    }
    return { text, truncated: false };
}

export function extractBlockText(block: BlockNode, options?: TextExtractOptions): string {
    try {
        switch (block.type) {
            case 'paragraph':
            case 'heading':
                return (block.children ?? []).map((i) => extractInlineText(i, options)).join('');
            case 'list':
                return (block.items ?? []).map((i) => (i.blocks ?? []).map((b) => extractBlockText(b, options)).join('\n')).join('\n');
            case 'quote':
            case 'thought':
                return (block.blocks ?? []).map((b) => extractBlockText(b, options)).join('\n');
            case 'code':
                return block.code ?? '';
            case 'math':
                return block.source ?? '';
            case 'table': {
                const rows = [...(block.headerRows ?? []), ...(block.rows ?? [])];
                return rows.map((r) => (r.cells ?? []).map((c) => (c.children ?? []).map((i) => extractInlineText(i, options)).join('')).join(' | ')).join('\n');
            }
            case 'image':
                return block.alt ?? '';
            case 'file':
                return block.label ?? '';
            case 'thematicBreak':
                return '';
            case 'unknown':
                return block.text;
            default:
                return '';
        }
    } catch {
        return '';
    }
}

export function extractInlineText(inline: InlineNode, options?: TextExtractOptions): string {
    try {
        switch (inline.type) {
            case 'text':
                return inline.text ?? '';
            case 'strong':
            case 'emphasis':
            case 'strikethrough':
                return (inline.children ?? []).map((i) => extractInlineText(i, options)).join('');
            case 'inlineCode':
                return inline.code ?? '';
            case 'image':
                return inline.alt ?? '';
            case 'link':
                return (inline.children ?? []).map((i) => extractInlineText(i, options)).join('');
            case 'inlineMath':
                return inline.source ?? '';
            case 'citationRef':
                return inline.label ?? options?.citationLabel?.(inline.citationId) ?? '';
            case 'lineBreak':
                return '\n';
            default:
                return '';
        }
    } catch {
        return '';
    }
}
