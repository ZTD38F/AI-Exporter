import type { BlockNode } from '../../../../l2/content/blocks.js';

/** Gemini hides confirmed grounding tokens in code, but quoted code literals are authored data. */
export function closeGeminiCodeCitations(blocks: BlockNode[], markers: readonly string[] = []): void {
    const normalize = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ');
    const confirmed = new Set(markers.filter(marker => /^\[cite:\s*\d+(?:\s*,\s*\d+)*\]$/i.test(marker)).map(normalize));
    if (!confirmed.size) return;
    const clean = (code: string): string => {
        let output = '', quote = '';
        for (let i = 0; i < code.length;) {
            if (quote) {
                if (code[i] === '\\' && i + 1 < code.length) {
                    output += code.slice(i, i + 2); i += 2;
                } else if (code.startsWith(quote, i)) {
                    output += quote; i += quote.length; quote = '';
                } else { output += code[i++]; }
                continue;
            }
            const char = code[i];
            // An apostrophe inside a word in a text diagram is not a string delimiter.
            if ((char === '"' || char === "'" || char === '`')
                && !(char === "'" && /[\p{L}\p{N}]/u.test(code[i - 1] ?? '') && /[\p{L}\p{N}]/u.test(code[i + 1] ?? ''))) {
                quote = code.startsWith(char.repeat(3), i) ? char.repeat(3) : char;
                output += quote; i += quote.length;
                continue;
            }
            if (char === '[') {
                const marker = /^\[cite:\s*\d+(?:\s*,\s*\d+)*\]/i.exec(code.slice(i))?.[0];
                if (marker && confirmed.has(normalize(marker))) { i += marker.length; continue; }
            }
            output += code[i++];
        }
        return output;
    };
    const visit = (block: BlockNode): void => {
        if (block.type === 'code') block.code = clean(block.code);
        else if (block.type === 'quote') block.blocks.forEach(visit);
        else if (block.type === 'list') block.items.forEach(item => item.blocks.forEach(visit));
    };
    blocks.forEach(visit);
}
