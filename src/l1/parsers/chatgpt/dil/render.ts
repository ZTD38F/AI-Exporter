import { component } from './components.js';
import { expression, type Scope } from './expression.js';
import { parseDil, type DilNode } from './syntax.js';

interface Part { text?: string; unsupported?: string }
interface DilRenderResult { text: string; modules: string[]; fallbackBlocks: number; unsupported: string[]; incomplete: boolean }
function projection(text: string): { text: string; offsets: number[]; ends: number[] } {
    const chars: string[] = [], offsets: number[] = [], ends: number[] = [];
    for (const match of text.matchAll(/\uE200image_group\uE202[^\uE201]*\uE201|&#(?:x[\da-f]+|\d+);|[\p{L}\p{N}]/giu)) {
        if (match[0].startsWith('\uE200')) continue;
        let value = match[0];
        if (value.startsWith('&#')) {
            const hex = value[2].toLowerCase() === 'x';
            const code = parseInt(value.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
            if (code > 0x10ffff) continue;
            value = String.fromCodePoint(code);
        }
        if (/[\p{L}\p{N}]/u.test(value)) {
            chars.push(value);
            // Anchor indexes use UTF-16 offsets, including supplementary letters
            // and numeric entities that occupy several raw source characters.
            for (let i = 0; i < value.length; i++) {
                offsets.push(match.index);
                ends.push(match.index + match[0].length);
            }
        }
    }
    return { text: chars.join(''), offsets, ends };
}

/** Unique neighboring text anchors permit fallback only for an unresolved
 * component. Ambiguous anchors fail closed to a reported whole-message fallback. */
function fallbackHoles(parts: Part[], fallback: string): { text: string; count: number } | undefined {
    const projected = projection(fallback); let count = 0;
    for (let i = 0; i < parts.length; i++) {
        if (!parts[i].unsupported) continue;
        let next = i + 1; while (next < parts.length && (parts[next].unsupported || !parts[next].text?.trim())) next++;
        const previousText = parts.slice(0, i).reverse().find(part => projection(part.text ?? '').text.length >= 16)?.text ?? '';
        const followingText = parts.slice(next).find(part => projection(part.text ?? '').text.length >= 16)?.text ?? '';
        const before = projection(previousText).text.slice(-120);
        const after = projection(followingText).text.slice(0, 120);
        const unique = (anchor: string) => anchor.length >= 16 && projected.text.indexOf(anchor) >= 0 && projected.text.indexOf(anchor) === projected.text.lastIndexOf(anchor);
        if (before && !unique(before) || after && !unique(after) || !before && !after) return undefined;
        const start = before ? projected.text.indexOf(before) + before.length : 0;
        const end = after ? projected.text.indexOf(after) : projected.text.length;
        if (start > end || start < 0 || end < 0) return undefined;
        let rawStart = before ? projected.ends[start - 1] : 0;
        const suffix = /[^\p{L}\p{N}]*$/u.exec(previousText.trim())?.[0] ?? '';
        if (suffix && fallback.startsWith(suffix, rawStart)) rawStart += suffix.length;
        const rawEnd = after ? projected.offsets[end] : fallback.length;
        parts[i].text = fallback.slice(rawStart, rawEnd); count++;
        for (let j = i + 1; j < next; j++) parts[j].text = '';
        i = next - 1;
    }
    return { text: parts.map(part => part.text ?? '').join(''), count };
}

export function renderDil(source: string, fallback?: string): DilRenderResult {
    const modules = new Set<string>(), unsupported = new Set<string>(); let budget = 30_000, outputSize = 0;
    const scope: Scope = new Map();
    const walk = (nodes: DilNode[], context: Scope): Part[] => {
        const result: Part[] = [];
        for (const node of nodes) {
            if (--budget < 0) throw new Error('Component render limit');
            try {
                if (node.kind === 'text') { result.push({ text: node.name }); continue; }
                if (node.kind === 'body') {
                    modules.add('bindings');
                    const state = /^(?:const|let)\s+\[\s*([\w$]+)\s*,\s*[\w$]+\s*\]\s*=\s*DIL\.useState\(([\s\S]*)\)\s*;?$/.exec(node.name);
                    const literal = /^(?:const|let)\s+([\w$]+)\s*=\s*([\s\S]*?);?$/.exec(node.name);
                    if (state) context.set(state[1], expression(state[2], context));
                    else if (literal) context.set(literal[1], expression(literal[2], context));
                    else throw new Error('Unsupported declaration');
                    continue;
                }
                if (node.kind === 'expression') {
                    modules.add('expressions'); const value = expression(node.name, context);
                    if (value !== null && typeof value === 'object') throw new Error('Non-scalar visible expression');
                    result.push({ text: value === null ? '' : String(value).replace(/[\\`*_[\]<>]/g, '\\$&') }); continue;
                }
                if (node.kind === 'each') {
                    modules.add('each');
                    const loop = /^([\s\S]+?)\s+as\s+([\w$]+)(?:\s*,\s*([\w$]+))?$/.exec(node.name);
                    if (!loop) throw new Error('Unsupported loop'); const values = expression(loop[1], context);
                    if (!Array.isArray(values) || values.length > 500) throw new Error('Unsupported iterable');
                    if (!values.length) result.push(...walk(node.alternate, new Map(context)));
                    values.forEach((value, index) => {
                        const local = new Map(context); local.set(loop[2], value); if (loop[3]) local.set(loop[3], index);
                        result.push(...walk(node.children, local));
                    }); continue;
                }
                if (node.kind === 'if') {
                    modules.add('if'); result.push(...walk(expression(node.name, context) ? node.children : node.alternate, new Map(context))); continue;
                }
                modules.add(node.name);
                const children: Part[] = node.name === 'CodeBlock' || node.name === 'svg'
                    ? node.children.map(child => ({ text: child.name })) : walk(node.children, new Map(context));
                // Keep unresolved children as separate holes instead of discarding
                // the entire parent layout card and its already parsed siblings.
                if (children.some(child => child.unsupported)) {
                    if (!['box', 'row', 'column', 'grid', 'grid-item', 'text', 'p', 'radio-group', 'checkbox-group'].includes(node.name)) throw new Error('Unsupported component child');
                    result.push({ text: '\n\n' }, ...children, { text: '\n\n' });
                } else result.push({ text: component(node, children.map(child => child.text ?? '').join(''), context, source) });
            } catch {
                const name = node.kind === 'element' ? node.name : node.kind;
                unsupported.add(name); result.push({ unsupported: name });
            }
        }
        outputSize += result.reduce((size, part) => size + (part.text?.length ?? 0), 0);
        if (outputSize > 4_000_000) throw new Error('Component output limit');
        return result;
    };
    try {
        const parts = walk(parseDil(source), scope);
        let text = parts.map(part => part.text ?? '').join(''), fallbackBlocks = 0;
        if (unsupported.size) {
            const local = fallback?.trim() ? fallbackHoles(parts, fallback) : undefined;
            if (local) { text = local.text; fallbackBlocks = local.count; }
            else if (fallback?.trim()) { text = fallback; fallbackBlocks = 1; }
            else {
                text = parts.map(part => part.unsupported ? '\n\n> Interactive component unavailable: ' + part.unsupported + '.\n\n' : part.text ?? '').join('');
            }
        }
        // A source/fallback disagreement must never silently erase provider text.
        // A subsequence permits legitimately restored loop labels in-place.
        if (fallback?.trim() && !preservesFallback(text, fallback)) {
            text = fallback; fallbackBlocks = 1; unsupported.add('source-fallback-disagreement');
        }
        return { text, modules: [...modules], fallbackBlocks, unsupported: [...unsupported], incomplete: unsupported.size > 0 && !fallback?.trim() };
    } catch {
        return { text: fallback?.trim() ? fallback : '> Interactive content unavailable: unsupported component structure.',
            modules: [...modules], fallbackBlocks: fallback?.trim() ? 1 : 0, unsupported: ['structure-or-limit'], incomplete: !fallback?.trim() };
    }
}

function preservesFallback(text: string, fallback: string): boolean {
    const actual = projection(text).text, expected = projection(fallback).text;
    let at = 0;
    for (const c of expected) { at = actual.indexOf(c, at); if (at < 0) return false; at += c.length; }
    return true;
}
