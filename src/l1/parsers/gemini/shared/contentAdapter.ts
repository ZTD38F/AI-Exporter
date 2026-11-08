import type { BlockNode } from '../../../../l2/content/blocks.js';
import { parseMarkdownToBlocks, type MarkdownParseContext } from '../../shared/markdown/index.js';
import type { ResourceEvidence } from '../../shared/resources/resourceEvidence.js';
import type { GeminiStructuredDocument } from '../rpc/structuredContent.js';
import type { ImageAttachment } from '../rpc/sourceAttachments.js';
import { convertHtmlToMarkdown } from '../../shared/html/htmlToMarkdown.js';
import { stripInternalChipMarkdown } from '../../shared/chipUtils.js';
import { preprocessGeminiMarkdown, normalizeGeminiTexAliases } from './markdownCompatibility.js';
import { geminiStructuredToContent, type GeminiSourceCitations } from './structuredContentAdapter.js';
import type { InlineNode } from '../../../../l2/content/inline.js';
import { normalizeTextUnderscores } from '../../../../shared/utils/latexCompatibility.js';
import { hasLiteralMathText, recoverLiteralMath } from './literalMathRecovery.js';

/** Work only on parsed math nodes; code, user prose and file names stay literal. */
function normalizeGeminiMath(blocks: BlockNode[]): BlockNode[] {
    const math = (source: string): string => normalizeGeminiTexAliases(normalizeTextUnderscores(source));
    const inlines = (nodes: InlineNode[]): void => nodes.forEach(node => {
        if (node.type === 'inlineMath') node.source = math(node.source);
        else if ('children' in node) inlines(node.children);
    });
    const visit = (nodes: BlockNode[]): void => nodes.forEach(node => {
        if (node.type === 'math') node.source = math(node.source);
        else if ('children' in node) inlines(node.children);
        else if (node.type === 'quote') visit(node.blocks);
        else if (node.type === 'list') node.items.forEach(item => visit(item.blocks));
        else if (node.type === 'table') {
            if (node.caption) inlines(node.caption);
            [...(node.headerRows ?? []), ...node.rows].forEach(row => row.cells.forEach(cell => inlines(cell.children)));
        } else if (node.type === 'image') {
            if (node.caption) inlines(node.caption);
        } else if (node.type === 'file') {
            if (node.description) inlines(node.description);
        }
    });
    visit(blocks);
    return blocks;
}

/** Native RPC prompts are literal textbox contents, not model-authored Markdown. */
export function parseGeminiPrompt(content: string): BlockNode[] {
    if (!content) return [];
    const children: InlineNode[] = [];
    content.split(/\r\n|\r|\n/).forEach((text, index) => {
        if (index) children.push({ type: 'lineBreak', kind: 'hard' });
        if (text) children.push({ type: 'text', text });
    });
    return [{ type: 'paragraph', children }];
}

function cleanGeminiBody(text: string): string {
    return stripInternalChipMarkdown(convertHtmlToMarkdown(text));
}

/** Provider syntax ends here. Resource references are bound by the caller's neutral parse hook. */
export function parseGeminiBody(
    content: string,
    structuredContent?: GeminiStructuredDocument,
    context: MarkdownParseContext & { sourceCitations?: GeminiSourceCitations; recoverLiteralMath?: boolean } = { diagnostics: [], sourceRef: { providerId: 'gemini', locator: 'content' } },
): BlockNode[] {
    const cleaned = cleanGeminiBody(content);
    if (structuredContent) {
        const structured = geminiStructuredToContent(structuredContent, context.sourceCitations);
        if (structured !== null && (structured.length > 0 || !cleaned.trim())) {
            if (context.recoverLiteralMath !== false && cleaned.includes('$') && hasLiteralMathText(structured)) {
                const markdown = parseMarkdownToBlocks(preprocessGeminiMarkdown(cleaned), '', {
                    ...context, diagnostics: [], lineStartDisplayMath: true, preserveCodeFenceFinalNewline: true,
                });
                const recovered = recoverLiteralMath(structured, markdown);
                if (recovered) context.diagnostics.push({ severity: 'info', code: 'GEMINI_LITERAL_MATH_RECOVERED',
                    message: 'Recovered native literal math from the matching raw Markdown paragraph',
                    sourceRef: context.sourceRef, details: { recovered } });
            }
            return normalizeGeminiMath(structured);
        }
        context.diagnostics.push({
            severity: 'warning', code: 'GEMINI_STRUCTURED_FALLBACK',
            message: 'Structured body could not be adapted; using Markdown fallback',
            sourceRef: context.sourceRef, details: { reason: 'adapter_rejected',
                structuredDocumentJson: JSON.stringify(structuredContent), fallbackMarkdown: content },
        });
    }
    // GM-MD-004: display fences without blank lines; fenced code preserves its
    // physical final newline just as the native code string does.
    return normalizeGeminiMath(parseMarkdownToBlocks(preprocessGeminiMarkdown(cleaned), '', {
        ...context, lineStartDisplayMath: true, preserveCodeFenceFinalNewline: true,
    }));
}

/** Adapt body-local facts already decoded by the resource pipeline. */
export function structuredBodyAttachments(message: { structuredImages: ImageAttachment[] }): ResourceEvidence[] {
    return message.structuredImages.map(image => ({
        ...image, type: 'image', src: image.sourceUrl,
        name: image.fileName ?? image.title, title: image.fileName ?? image.title,
    }));
}

/** Parse provider-exposed reasoning before it crosses the semantic input boundary. */
export function parseSourceReasoning(reasoning: string | undefined, context: MarkdownParseContext): BlockNode[] | undefined {
    if (reasoning === undefined) return undefined;
    const cleaned = cleanGeminiBody(reasoning);
    return cleaned.trim() ? normalizeGeminiMath(parseMarkdownToBlocks(preprocessGeminiMarkdown(cleaned), '', context)) : undefined;
}
