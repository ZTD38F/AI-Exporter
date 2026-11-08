/** Syntax only: archive URL/path semantics remain in the Python resolver. */
import { readFileSync } from 'node:fs';
import type { Root, RootContent } from 'mdast';
import { parseMarkdownAst } from '../src/l1/parsers/shared/markdown/parseMarkdown.js';
import { collectDefinitions } from '../src/l1/parsers/shared/markdown/mdastToContent.js';

interface MarkdownResourceReference {
    kind: 'image' | 'link';
    reference: string;
}

export function extractMarkdownResourceReferences(markdown: string): MarkdownResourceReference[] {
    const tree = parseMarkdownAst(markdown);
    const definitions = new Map<string, { url: string; title?: string }>();
    collectDefinitions(tree, definitions);
    const references: MarkdownResourceReference[] = [];
    const visit = (node: Root | RootContent): void => {
        if (node.type === 'link' || node.type === 'image') {
            references.push({ kind: node.type, reference: node.url });
        } else if (node.type === 'linkReference' || node.type === 'imageReference') {
            const definition = definitions.get(node.identifier.trim().toLowerCase());
            if (definition) references.push({
                kind: node.type === 'imageReference' ? 'image' : 'link', reference: definition.url,
            });
        }
        if ('children' in node) for (const child of node.children) visit(child);
    };
    visit(tree);
    return references;
}

if (require.main === module) {
    try {
        process.stdout.write(JSON.stringify(extractMarkdownResourceReferences(readFileSync(0, 'utf8'))));
    } catch (error) {
        process.stderr.write(`Markdown resource extraction failed: ${String(error)}\n`);
        process.exitCode = 1;
    }
}
