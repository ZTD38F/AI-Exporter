import type { BlockNode } from '../../../l2/content/blocks.js';

export function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : null;
}
export function plain(text: string): BlockNode {
    return { type: 'paragraph', children: [{ type: 'text', text }] };
}
