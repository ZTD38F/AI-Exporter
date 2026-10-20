/**
 * src/core/export/canonical/markdown/parseMarkdown.ts
 *
 * Markdown parsing pipeline using mdast-util-from-markdown + micromark extensions (GFM, Math)
 * and adapting the resulting MDAST into Canonical AST BlockNode[].
 */

import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { math } from 'micromark-extension-math';
import { mathFromMarkdown } from 'mdast-util-math';
import type { BlockNode } from '../blocks.js';
import type { InlineNode } from '../inline.js';
import type { Root } from 'mdast';
import { preprocessGeminiMarkdown } from '../compat/rules.js';
import {
    type MarkdownParseContext,
    mdastRootToBlocks,
    adaptInlines,
    collectDefinitions,
} from './mdastToCanonical.js';

export { type MarkdownParseContext } from './mdastToCanonical.js';

const EXTENSIONS = [gfm(), math()];
const MDAST_EXTENSIONS = [gfmFromMarkdown(), mathFromMarkdown()];

/** Parse Markdown syntax only; provider preprocessing belongs to the caller. */
export function parseMarkdownAst(source: string): Root {
    return fromMarkdown(source, {
        extensions: EXTENSIONS,
        mdastExtensions: MDAST_EXTENSIONS,
    });
}

/**
 * Parse a markdown string into Canonical AST BlockNode[].
 */
export function parseMarkdownToBlocks(
    markdown: string,
    idPrefix: string,
    ctx: MarkdownParseContext,
): BlockNode[] {
    if (!markdown || !markdown.trim()) {
        return [];
    }

    const preprocessed = preprocessGeminiMarkdown(markdown);
    const tree = parseMarkdownAst(preprocessed);

    const definitions = new Map<string, { url: string; title?: string }>();
    collectDefinitions(tree, definitions);
    const parseCtx: MarkdownParseContext = {
        ...ctx,
        definitions,
    };

    return mdastRootToBlocks(tree, parseCtx, preprocessed);
}

/**
 * Parse an inline markdown snippet into Canonical AST InlineNode[].
 */
export function parseMarkdownToInlines(
    text: string,
    idPrefix: string,
    ctx: MarkdownParseContext,
): InlineNode[] {
    if (!text) {
        return [];
    }

    const tree = parseMarkdownAst(text);

    const definitions = new Map<string, { url: string; title?: string }>();
    collectDefinitions(tree, definitions);
    const parseCtx: MarkdownParseContext = {
        ...ctx,
        definitions,
    };

    // Inlines are inside the first paragraph if fromMarkdown wraps them in a paragraph
    if (tree.children.length === 1 && tree.children[0].type === 'paragraph') {
        return adaptInlines(tree.children[0].children, parseCtx);
    }

    // Otherwise, adapt blocks and extract inlines from paragraphs
    const blocks = mdastRootToBlocks(tree, parseCtx, text);
    const inlines: InlineNode[] = [];
    for (const b of blocks) {
        if ('children' in b && Array.isArray((b as any).children)) {
            inlines.push(...(b as any).children);
        }
    }
    return inlines;
}
