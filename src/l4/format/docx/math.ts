import katex from 'katex';
import { DOMParser, onErrorStopParsing, type Element, type Node } from '@xmldom/xmldom';
import { BuilderElement, Math as WordMath, MathRun, type XmlComponent } from 'docx';

const element = (name: string, children: readonly XmlComponent[] = []): XmlComponent =>
    new BuilderElement({ name, children });
const closingBracket = new Map([['(', ')'], ['[', ']']]);
const value = (name: string, val: string): XmlComponent =>
    new BuilderElement({ name, attributes: { val: { key: 'm:val', value: val } } });

// xmldom's base Node type does not narrow to Element on nodeType. This guard is
// confined to the XML boundary; only KaTeX-generated MathML enters this adapter.
function isElement(node: Node): node is Element { return node.nodeType === node.ELEMENT_NODE; }
function children(node: Element): Element[] {
    const result: Element[] = [];
    for (let child = node.firstChild; child; child = child.nextSibling) {
        if (isElement(child)) result.push(child);
    }
    return result;
}
function unsupported(): never { throw new Error('Unsupported MathML structure'); }

/** Convert only supported structures, atomically: a failure preserves the whole
 * original LaTeX at the renderer, never a partially converted equation. */
function convert(node: Element, depth = 0, inheritedVariant?: string): XmlComponent[] {
    if (depth > 64) return unsupported();
    // KaTeX appends U+2061 to scripts containing \max/\min, even
    // outside the MathML script's formal arity. It is not an extra operand.
    const parts = children(node).filter(child => !(child.localName === 'mo' && child.textContent === '\u2061'));
    const variant = node.getAttribute('mathvariant') || inheritedVariant;
    const render = (part: Element): XmlComponent[] => convert(part, depth + 1, variant);
    const all = (nodes = parts): XmlComponent[] => {
        const result: XmlComponent[] = [];
        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            // Plain TeX parentheses are separate MathML operators. A script on
            // the closing parenthesis must apply to the enclosed expression,
            // not an isolated ')' run (which readers may reject as unbalanced).
            const matching = node.localName === 'mo' ? closingBracket.get(node.textContent || '') : undefined;
            if (matching) {
                let nesting = 1;
                for (let j = i + 1; j < nodes.length; j++) {
                    const end = nodes[j];
                    const scripted = ['msub', 'msup', 'msubsup'].includes(end.localName || '');
                    const endParts = children(end);
                    const token = scripted ? endParts[0] : end;
                    if (token?.localName !== 'mo') continue;
                    if (token.textContent === node.textContent) nesting++;
                    if (token.textContent !== matching || --nesting !== 0) continue;
                    const bracket = element('m:d', [
                        element('m:dPr', [value('m:begChr', node.textContent || ''), value('m:endChr', matching)]),
                        element('m:e', all(nodes.slice(i + 1, j))),
                    ]);
                    if (scripted) {
                        const name = end.localName === 'msup' ? 'm:sSup' : end.localName === 'msub' ? 'm:sSub' : 'm:sSubSup';
                        result.push(element(name, [element('m:e', [bracket]),
                            ...(end.localName !== 'msup' ? [element('m:sub', endParts[1] ? render(endParts[1]) : unsupported())] : []),
                            ...(end.localName !== 'msub' ? [element('m:sup', endParts[end.localName === 'msup' ? 1 : 2]
                                ? render(endParts[end.localName === 'msup' ? 1 : 2]) : unsupported())] : []),
                        ]));
                    } else result.push(bracket);
                    i = j;
                    break;
                }
                if (nodes[i] !== node) continue;
            }
            const base = children(node)[0];
            const last = base && children(base).at(-1);
            const scriptedFunction = ['munder', 'mover', 'munderover', 'msub', 'msup', 'msubsup'].includes(node.localName ?? '')
                && last?.localName === 'mo' && last.textContent === '\u2061';
            const next = nodes[i + 1];
            if (scriptedFunction && next) {
                // MathML puts function application inside the scripted name.
                // OMML requires a function container, otherwise some readers
                // attach the limit name to the following fraction's numerator.
                result.push(element('m:func', [element('m:fName', render(node)), element('m:e', all(nodes.slice(i + 1)))]));
                break;
            } else result.push(...render(node));
        }
        return result;
    };
    const part = (index: number): XmlComponent[] => {
        const child = parts[index];
        return child ? render(child) : unsupported();
    };
    const nonempty = (parts: XmlComponent[]): XmlComponent[] => parts.length ? parts : [new MathRun('\u200b')];
    const argument = (name: string, index: number): XmlComponent => element(name, nonempty(part(index)));
    switch (node.localName) {
        case 'mrow': {
            const first = parts[0];
            const last = parts[parts.length - 1];
            const open = first?.localName === 'mo' && first.getAttribute('fence') === 'true';
            const close = parts.length > 1 && last?.localName === 'mo' && last.getAttribute('fence') === 'true';
            const fence = (text: string): string => text === '∣' ? '|' : text === '∥' ? '‖' : text;
            if (open || close) return [element('m:d', [
                element('m:dPr', [value('m:begChr', open ? fence(first.textContent || '') : ''),
                    value('m:endChr', close ? fence(last.textContent || '') : '')]),
                element('m:e', all(parts.slice(open ? 1 : 0, close ? -1 : undefined))),
            ])];
            return all();
        }
        case 'mstyle':
            // Sizes and display style are layout hints. Color does not alter the
            // expression; unsupported structural tags still fail below.
            return all();
        case 'mi': case 'mn': case 'mo': case 'mtext': {
            if (parts.length) return unsupported();
            const text = node.textContent || '';
            if (node.localName === 'mo' && text === '\u2061') return []; // invisible function application
            if (node.localName === 'mtext') return [new MathRun({ text, normalText: true })];
            switch (variant) {
                case undefined: return [new MathRun({ text, ...(node.localName !== 'mi' || [...text].length > 1 ? { style: 'plain' } : {}) })];
                case 'normal': return [new MathRun({ text, style: 'plain' })];
                case 'italic': return [new MathRun({ text, style: 'italic' })];
                case 'bold': return [new MathRun({ text, style: 'bold' })];
                case 'bold-italic': return [new MathRun({ text, style: 'boldItalic' })];
                case 'double-struck': return [new MathRun({ text, script: 'doubleStruck' })];
                case 'script': return [new MathRun({ text, script: 'script' })];
                case 'fraktur': return [new MathRun({ text, script: 'fraktur' })];
                case 'sans-serif': return [new MathRun({ text, script: 'sansSerif' })];
                case 'monospace': return [new MathRun({ text, script: 'monospace' })];
                default: return unsupported();
            }
        }
        case 'mspace': return Number.parseFloat(node.getAttribute('width') || '0') > 0 ? [new MathRun(' ')] : [];
        case 'mfrac': {
            if (parts.length !== 2) return unsupported();
            const thickness = node.getAttribute('linethickness');
            if (thickness && thickness !== '0px' && thickness !== '0') return unsupported();
            return [element('m:f', [
                ...(thickness ? [element('m:fPr', [value('m:type', 'noBar')])] : []),
                argument('m:num', 0), argument('m:den', 1),
            ])];
        }
        case 'msup': case 'msub': case 'msubsup': {
            if (parts.length !== (node.localName === 'msubsup' ? 3 : 2)) return unsupported();
            const base = parts[0];
            if (base && children(base).some(child => child.localName === 'mo' && child.textContent === '\u2061')) {
                const lower = node.localName !== 'msup';
                const low = lower ? element('m:limLow', [argument('m:e', 0), argument('m:lim', 1)]) : undefined;
                return node.localName === 'msub' ? [low ?? unsupported()] : [element('m:limUpp', [
                    element('m:e', low ? [low] : part(0)), argument('m:lim', node.localName === 'msup' ? 1 : 2),
                ])];
            }
            const name = node.localName === 'msup' ? 'm:sSup' : node.localName === 'msub' ? 'm:sSub' : 'm:sSubSup';
            return [element(name, [argument('m:e', 0),
                ...(node.localName !== 'msup' ? [argument('m:sub', 1)] : []),
                ...(node.localName !== 'msub' ? [argument('m:sup', node.localName === 'msup' ? 1 : 2)] : []),
            ])];
        }
        case 'msqrt': return [element('m:rad', [element('m:radPr', [value('m:degHide', '1')]),
            element('m:deg'), element('m:e', all())])];
        case 'mroot':
            if (parts.length !== 2) return unsupported();
            return [element('m:rad', [argument('m:deg', 1), argument('m:e', 0)])];
        case 'munder': case 'mover': case 'munderover': {
            if (parts.length !== (node.localName === 'munderover' ? 3 : 2)) return unsupported();
            const accent = node.getAttribute('accent') === 'true' || node.getAttribute('accentunder') === 'true';
            if (accent) {
                const symbol = parts[1]?.textContent;
                if ((node.localName === 'mover' && (symbol === '‾' || symbol === '¯' || symbol === 'ˉ'))
                    || (node.localName === 'munder' && symbol === '―')) {
                    return [element('m:bar', [element('m:barPr', [value('m:pos', node.localName === 'mover' ? 'top' : 'bot')]), argument('m:e', 0)])];
                }
                if (node.localName !== 'mover') return unsupported();
                const mark = symbol === '^' ? '\u0302' : symbol === '~' ? '\u0303' : symbol;
                if (!mark || !['\u0302', '\u0303', '\u20d7', '˙', '¨', '→'].includes(mark)) return unsupported();
                return [element('m:acc', [element('m:accPr', [value('m:chr', mark)]), argument('m:e', 0)])];
            }
            const base = node.localName === 'munderover'
                ? [element('m:limLow', [argument('m:e', 0), argument('m:lim', 1)])] : part(0);
            return [element(node.localName === 'munder' ? 'm:limLow' : 'm:limUpp', [
                element('m:e', base), argument('m:lim', node.localName === 'munderover' ? 2 : 1),
            ])];
        }
        case 'mtable': {
            if (node.getAttribute('rowlines') || node.getAttribute('columnlines')) return unsupported();
            const rows = parts.map(row => {
                if (row.localName !== 'mtr') return unsupported();
                const cells = children(row);
                if (cells.some(cell => cell.localName !== 'mtd' || cell.getAttribute('columnspan') || cell.getAttribute('rowspan'))) return unsupported();
                return cells;
            });
            const columns = rows[0]?.length;
            if (!columns || rows.some(row => row.length !== columns)) return unsupported();
            const alignments = (node.getAttribute('columnalign') || 'center').split(/\s+/);
            const columnProperties = Array.from({ length: columns }, (_, i) => {
                const alignment = alignments[i] || alignments[alignments.length - 1];
                if (!['left', 'right', 'center'].includes(alignment)) return unsupported();
                return element('m:mc', [element('m:mcPr', [value('m:count', '1'), value('m:mcJc', alignment)])]);
            });
            return [element('m:m', [element('m:mPr', [value('m:plcHide', '1'), element('m:mcs', columnProperties)]),
                ...rows.map(row => element('m:mr', row.map(cell => element('m:e', nonempty(children(cell).flatMap(render)))))),
            ])];
        }
        default: return unsupported();
    }
}

function parseMath(source: string, displayMode: boolean): Element | undefined {
    if (!source.trim() || source.length > 20_000) return undefined;
    const mathml = katex.renderToString(source, {
        output: 'mathml', displayMode, throwOnError: true, trust: () => unsupported(),
        strict: 'error', maxExpand: 1000, maxSize: 20,
    });
    if (mathml.length > 500_000) return undefined;
    const xml = new DOMParser({ onError: onErrorStopParsing }).parseFromString(mathml, 'application/xml');
    const semantics = xml.getElementsByTagName('semantics').item(0);
    return semantics ? children(semantics)[0] : undefined;
}

/** Conservative inline width in points at the document's 11pt math size.
 * It is a layout budget, not a substitute for the reader's font metrics. */
export function docxMathWidth(source: string): number {
    const width = (node: Element): number => {
        const parts = children(node);
        const widths = parts.map(width);
        const sum = widths.reduce((a, b) => a + b, 0);
        switch (node.localName) {
            case 'mfrac': return Math.max(...widths, 0) + 1;
            case 'msup': case 'msub': case 'msubsup':
                return (widths[0] ?? 0) + 0.75 * Math.max(...widths.slice(1), 0);
            case 'munder': case 'mover': case 'munderover': return Math.max(...widths, 0);
            case 'msqrt': case 'mroot': return (widths[0] ?? 0) + 1;
            case 'mspace': return Math.max(0, Number.parseFloat(node.getAttribute('width') || '0'));
            case 'mtable': return Math.max(...widths, 0);
            case 'mtr': return sum + Math.max(0, parts.length - 1);
            default: return parts.length ? sum : [...(node.textContent || '')]
                .reduce((n, c) => n + (c === '\u2061' ? 0 : /[\u2E80-\uFFFF]/u.test(c) ? 1 : 0.65), 0);
        }
    };
    try {
        const expression = parseMath(source, false);
        return expression ? width(expression) * 11 : source.length * 6;
    } catch { return source.length * 6; }
}

export function renderDocxMath(source: string, displayMode: boolean): WordMath | undefined {
    if (!source.trim() || source.length > 20_000) return undefined;
    try {
        const expression = parseMath(source, displayMode);
        if (!expression) return undefined;
        const components = convert(expression);
        const math = new WordMath({ children: [] });
        // The library's MathComponent union omits matrix/limit/accent elements.
        // Its public XML child API accepts those native OMML components directly.
        for (const component of components) math.addChildElement(component);
        return math;
    } catch {
        return undefined;
    }
}
