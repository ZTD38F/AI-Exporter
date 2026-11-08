/**
 * src/l1/parsers/shared/markdown/parseMarkdown.ts
 *
 * Markdown parsing pipeline using mdast-util-from-markdown + micromark extensions (GFM, Math)
 * and adapting the resulting MDAST into Content AST BlockNode[].
 */

import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { math } from 'micromark-extension-math';
import { mathFromMarkdown } from 'mdast-util-math';
import type { BlockNode } from '../../../../l2/content/blocks.js';
import type { Root } from 'mdast';
import {
    type MarkdownParseContext,
    mdastRootToBlocks,
    collectDefinitions,
} from './mdastToContent.js';

export { type MarkdownParseContext } from './mdastToContent.js';

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
 * Parse a markdown string into Content AST BlockNode[].
 */
export function parseMarkdownToBlocks(
    markdown: string,
    idPrefix: string,
    ctx: MarkdownParseContext,
): BlockNode[] {
    if (!markdown || !markdown.trim()) {
        return [];
    }

    const preprocessed = markdown;
    const tree = parseMarkdownAst(preprocessed);

    const definitions = new Map<string, { url: string; title?: string }>();
    collectDefinitions(tree, definitions);
    const parseCtx: MarkdownParseContext = {
        ...ctx,
        definitions,
    };

    return mdastRootToBlocks(tree, parseCtx, preprocessed);
}
