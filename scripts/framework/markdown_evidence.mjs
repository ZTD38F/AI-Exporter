// Use the installed Markdown grammar, independently of the product renderer.
// Formatting nodes contribute their authored children; code/math keep source.
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { math } from 'micromark-extension-math';
import { mathFromMarkdown } from 'mdast-util-math';

// Reference footers are generated export metadata; the live reader separately
// removes Gemini's source-chip controls. Only recognize the trailing blockquote.
function literal(node) {
    return node.value ?? node.children?.map(literal).join('') ?? '';
}
let referenceNumbers = new Set();
const executionNodes = new WeakSet();
let visibleReference = '';
const compact = text => text.normalize('NFKC').replace(/[\s\u200b\ufeff]/gu, '');
// Gemini sometimes displays literal ** delimiters instead of rendering bold.
// Keep them only when that exact physical source span is also visible in the
// independent DOM evidence. Missing delimiters still fail full-text equality.
const visibleLiteral = text => visibleReference.includes(compact(text));
// Spaced dollar spans such as "$5 input / $30 output" are visible prose,
// not a formula. Keep their delimiters in the independent text/PDF evidence.
const spacedDollarText = node => node.type === 'inlineMath'
    && (node.value.startsWith(' ') || node.value.endsWith(' '));
const dollarSource = node => evidence.text.slice(node.position.start.offset, node.position.end.offset);
function authored(node) {
    const chunks = [];
    function add(text, verbatim = false, boundary = false) {
        const previous = chunks.at(-1);
        if (!verbatim && previous && !previous.verbatim && !previous.boundary) previous.text += text;
        else chunks.push({ text, verbatim, boundary });
    }
    function visit(current) {
        if (executionNodes.has(current)) return;
        if (current.type === 'text') add(current.value);
        // Code/math form immutable boundaries, preserving literal operators.
        else if (['code', 'inlineCode'].includes(current.type)) add(current.value, true);
        else if (spacedDollarText(current)) add(dollarSource(current));
        else if (['math', 'inlineMath'].includes(current.type)) add(current.value.replace(/\\\\\s*\[[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*(?:ex|em|pt|pc|px|cm|mm|in)\]/g, '\\\\').replace(/\\Vert\{\}/g, '\\|').replace(/\\vert\{\}/g, '|'), true);
        else if (current.type === 'html') add(/^<br\s*\/?>$/i.test(current.value) ? '' : current.value, true);
        else current.children?.forEach(visit);
        if (['paragraph', 'heading', 'tableCell', 'code', 'math'].includes(current.type)) add('', true, true);
    }
    visit(node);
    const protectedValues = [];
    let group = '';
    let result = '';
    function flush() {
        result += group
        // Gemini's intraword bold can span several CommonMark inline nodes.
        .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, (raw, body) => visibleLiteral(raw) ? raw : body)
        .replace(/\[\[(\d+(?:\],\s*\[\d+)*)\]\]/g, (text, numbers) =>
            numbers.match(/\d+/g).every(number => referenceNumbers.has(number)) ? '' : text)
        .replace(/\u0000(\d+)\u0000/g, (_, index) => protectedValues[Number(index)]);
        group = '';
    }
    for (const chunk of chunks) {
        if (chunk.boundary) flush();
        else if (chunk.verbatim) {
            protectedValues.push(chunk.text);
            group += `\u0000${protectedValues.length - 1}\u0000`;
        } else group += chunk.text;
    }
    flush();
    return result;
}

let input = '';
for await (const chunk of process.stdin) input += chunk;
const parsed = JSON.parse(input);
const evidence = typeof parsed === 'string' ? { text: parsed, visibleReference: '' } : parsed;
visibleReference = compact(evidence.visibleReference ?? '');
const tree = fromMarkdown(evidence.text, {
    extensions: [gfm(), math()],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
});
const codeBlocks = [];
const executions = new Map();
function collectCode(node) {
    if (node.type === 'code') {
        const match = /^[\w+-]+\?(code_reference|code_stdout)&code_event_index=(\d+)$/.exec(node.lang || '');
        if (match) {
            const key = match[1] === 'code_reference' ? 'code' : 'stdout';
            const event = executions.get(match[2]) || {};
            if (key in event) throw new Error('Duplicate execution source');
            event[key] = node.value;
            executions.set(match[2], event);
            executionNodes.add(node);
        } else codeBlocks.push(node.value);
    }
    node.children?.forEach(collectCode);
}
collectCode(tree);
const executionBlocks = [...executions.values()];
if (executionBlocks.some(event => !('code' in event))) throw new Error('Incomplete execution source');
// Gemini may execute a comment-only program without emitting stdout. Missing
// nonempty output still fails comparison with the independently captured DOM.
executionBlocks.forEach(event => event.stdout ??= '');
function removeAssetCaptions(node) {
    node.children?.forEach(removeAssetCaptions);
    // Generated image tiles export a filename caption after the image. It is
    // resource metadata, like the image alt label, rather than authored prose.
    node.children = node.children?.filter((child, index, siblings) => {
        // Standalone Packaging file links are attachment cards, like HTML's
        // gem-att-card. Their labels are resource metadata, not answer prose.
        if (child.type === 'paragraph' && child.children.length === 1
            && child.children[0].type === 'link' && child.children[0].url.startsWith('files/')) return false;
        const previous = siblings[index - 1];
        const image = previous?.type === 'paragraph' && previous.children.length === 1 ? previous.children[0] : null;
        return !(child.type === 'paragraph' && child.children.length === 1 && child.children[0].type === 'text'
            && image?.type === 'image' && image.url.startsWith('assets/')
            && /^[^/\n]+\.(?:png|jpe?g|gif|webp|svg)$/i.test(image.alt || '')
            && child.children[0].value === image.alt);
    });
}
removeAssetCaptions(tree);
const tail = tree.children.at(-1);
if (tail?.type === 'blockquote') {
    const text = literal(tail);
    if (/^🌐\s*(?:Sources|来源):\s*\[\d+\]/u.test(text)) {
        referenceNumbers = new Set([...text.matchAll(/(?:^|\n)\[(\d+)\]/g)].map(match => match[1]));
        tree.children.pop();
    }
}
// Optional ordered source segments for provider-independent PDF comparison.
// This walks the test grammar, never the product Domain or renderer AST.
const segments = [];
function collectSegments(node) {
    if (executionNodes.has(node)) return;
    if (spacedDollarText(node)) {
        const previous = segments.at(-1);
        if (previous?.kind === 'text') previous.text += dollarSource(node);
        else segments.push({ kind: 'text', text: dollarSource(node) });
    } else if (['math', 'inlineMath', 'code'].includes(node.type)) {
        segments.push({ kind: node.type === 'code' ? 'code' : 'math', text: node.value });
    } else if (['text', 'inlineCode'].includes(node.type)) {
        const previous = segments.at(-1);
        if (previous?.kind === 'text') previous.text += node.value;
        else segments.push({ kind: 'text', text: node.value });
    } else node.children?.forEach(collectSegments);
}
if (evidence.segments) collectSegments(tree);
process.stdout.write(JSON.stringify({ text: authored(tree), codeBlocks, executionBlocks,
    ...(evidence.segments ? { segments } : {}) }));
