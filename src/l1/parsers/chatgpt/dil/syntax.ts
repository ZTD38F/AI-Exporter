export interface DilNode {
    kind: 'text' | 'element' | 'body' | 'each' | 'if' | 'expression';
    name: string;
    attributes: string;
    start: number;
    end: number;
    children: DilNode[];
    alternate: DilNode[];
}

/** Quote-aware delimiters also handle braces in event handler props. Handlers
 * are only tokenized, never interpreted or passed to the expression reader. */
function closingBrace(source: string, start: number): number {
    let depth = 1, quote = '';
    for (let i = start + 1; i < source.length; i++) {
        const c = source[i];
        if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
        if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
        if (c === '{') depth++; else if (c === '}' && --depth === 0) return i;
    }
    throw new Error('Unclosed component expression');
}

const tagStart = /^<\/?[A-Za-z][\w-]*(?=[\s/>])/;
export function parseDil(source: string): DilNode[] {
    if (source.length > 1_000_000) throw new Error('Component source limit');
    let at = 0, budget = 30_000;
    const node = (kind: DilNode['kind'], name: string, start: number): DilNode =>
        ({ kind, name, attributes: '', start, end: at, children: [], alternate: [] });
    const read = (closing = '', depth = 0): { nodes: DilNode[]; stop: string } => {
        if (depth > 64) throw new Error('Component nesting limit');
        const nodes: DilNode[] = []; let textStart = at;
        const flush = () => { if (at > textStart) nodes.push({ ...node('text', source.slice(textStart, at), textStart), end: at }); };
        while (at < source.length) {
            if (--budget < 0) throw new Error('Component token limit');
            // Treat Markdown code and math as opaque, including component-like
            // strings, braces, comparison signs and XML inside code examples.
            const tail = source.slice(at);
            const fence = /^((?:`{3,}|~{3,})[`~]*)[^\n]*\n/.exec(tail);
            if (fence && (at === 0 || source[at - 1] === '\n')) {
                const run = fence[1];
                const end = new RegExp('^' + run[0] + '{' + run.length + ',}[ \\t]*$', 'm').exec(tail.slice(fence[0].length));
                if (end) { at += fence[0].length + end.index + end[0].length; continue; }
            }
            const ticks = /^`+/.exec(tail);
            if (ticks) {
                const run = ticks[0]; const end = source.indexOf(run, at + run.length);
                if (end >= 0) { at = end + run.length; continue; }
            }
            const mathClose = tail.startsWith('\\(') ? '\\)' : tail.startsWith('\\[') ? '\\]' : tail.startsWith('$$') ? '$$' : '';
            if (mathClose) { const end = source.indexOf(mathClose, at + 2); if (end >= 0) { at = end + mathClose.length; continue; } }
            if (source[at] === '$' && source[at - 1] !== '\\') { const end = source.indexOf('$', at + 1); if (end > at && !source.slice(at, end).includes('\n')) { at = end + 1; continue; } }
            const tag = tagStart.exec(tail);
            if (tag) {
                flush(); const start = at; const isClose = tail.startsWith('</');
                const name = tag[0].replace(/^<\/?/, ''); let end = at + tag[0].length, quote = '';
                for (; end < source.length; end++) {
                    const c = source[end];
                    if (quote) { if (c === '\\') end++; else if (c === quote) quote = ''; continue; }
                    if (c === '"' || c === "'") quote = c;
                    else if (c === '{') end = closingBrace(source, end);
                    else if (c === '>') break;
                }
                if (end === source.length) throw new Error('Unclosed component tag');
                const attributes = source.slice(at + tag[0].length, end); at = end + 1;
                if (isClose) {
                    if (name !== closing) throw new Error('Mismatched component tag');
                    return { nodes, stop: name };
                }
                const element = node('element', name, start); element.attributes = attributes.replace(/\/\s*$/, '');
                if (!/\/\s*$/.test(attributes) && name !== 'br' && name !== 'input') {
                    if (['CodeBlock', 'svg'].includes(name)) {
                        const close = source.indexOf(`</${name}>`, at); if (close < 0) throw new Error('Unclosed opaque component');
                        element.children = [{ ...node('text', source.slice(at, close), at), end: close }]; at = close + name.length + 3;
                    } else { const result = read(name, depth + 1); if (result.stop !== name) throw new Error('Unclosed component'); element.children = result.nodes; }
                }
                element.end = at; nodes.push(element); textStart = at; continue;
            }
            if (source[at] === '{' && (/^\{(?:@body\b|#each\b|#if\b|\/each\s*}|\/if\s*}|:else\s*})/.test(tail)
                || (closing && /^\{(?:[A-Za-z_$]|\[|["'])/.test(tail)))) {
                flush(); const start = at; const end = closingBrace(source, at); const directive = source.slice(at + 1, end).trim(); at = end + 1;
                if (directive.startsWith('/') || directive === ':else') return { nodes, stop: directive };
                let current: DilNode;
                if (directive.startsWith('@body')) current = node('body', directive.slice(5).trim(), start);
                else if (directive.startsWith('#each') || directive.startsWith('#if')) {
                    const each = directive.startsWith('#each'); current = node(each ? 'each' : 'if', directive.slice(each ? 5 : 3).trim(), start);
                    const content = read(each ? '/each' : '/if', depth + 1); current.children = content.nodes;
                    let stop = content.stop;
                    if (stop === ':else') { const alternate = read(each ? '/each' : '/if', depth + 1); current.alternate = alternate.nodes; stop = alternate.stop; }
                    if (stop !== (each ? '/each' : '/if')) throw new Error('Unclosed component directive');
                } else current = node('expression', directive, start);
                current.end = at; nodes.push(current); textStart = at; continue;
            }
            at++;
        }
        flush(); return { nodes, stop: '' };
    };
    const parsed = read(); if (parsed.stop) throw new Error('Unexpected component closer'); return parsed.nodes;
}

export function attribute(node: DilNode, name: string): string | undefined {
    // Tokenize props; never search inside another prop's handler/string value.
    let at = 0; const source = node.attributes;
    while (at < source.length) {
        while (/\s/.test(source[at] ?? '') && at < source.length) at++;
        const key = /^[\w-]+/.exec(source.slice(at))?.[0]; if (!key) break; at += key.length;
        while (/\s/.test(source[at] ?? '') && at < source.length) at++;
        if (source[at] !== '=') { if (key === name) return 'true'; continue; }
        at++; while (/\s/.test(source[at] ?? '') && at < source.length) at++;
        const start = at;
        if (source[at] === '{') at = closingBrace(source, at) + 1;
        else if (source[at] === '"' || source[at] === "'") {
            const quote = source[at++]; while (at < source.length && source[at] !== quote) { if (source[at] === '\\') at++; at++; } at++;
        } else { while (at < source.length && !/\s/.test(source[at])) at++; }
        if (key === name) return source.slice(start, at);
    }
    return undefined;
}
