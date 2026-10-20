import { assetPresentation, assetCaptionText } from './assetPresentation.js';
import type { CanonicalConversationBundle, MessageRole } from './conversation.js';
import type { BlockNode } from './blocks.js';
import type { InlineNode } from './inline.js';
import { citationDisplayLabel } from './citations.js';
import { getRendererStrings } from './rendererStrings.js';

export interface CanonicalMarkdownOptions {
    lang?: 'zh' | 'en';
}

function escapeText(text: string): string {
    return text.replace(/\\/g, '\\\\').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))
        .replace(/([`*_\[\]#~$])/g, '\\$1').replace(/^(\s*)([-+] |\d+[.)] )/gm, (_, space: string, marker: string) => space + marker.replace(/[-+.)]/, '\\$&'));
}

function destination(value: string): string | undefined {
    if (/^[\s]*([a-z][a-z\d+.-]*):/i.test(value) && !/^(https?:|mailto:)/i.test(value)) return undefined;
    return value.replace(/[\s()<>]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

function codeSpan(value: string): string {
    const fence = '`'.repeat(Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length)) + 1);
    const pad = /(^`|`$|^ .* $)/.test(value) ? ' ' : '';
    return `${fence}${pad}${value}${pad}${fence}`;
}

/** Serialize the Canonical document in source message order. Assets use archive-local refs only. */
export function renderCanonicalMarkdown(
    bundle: CanonicalConversationBundle,
    options: CanonicalMarkdownOptions = {},
): string {
    const conversation = bundle.conversation;
    const assets = new Map(bundle.assets.map((asset) => [asset.id, asset]));
    const citations = new Map(bundle.citations.map((citation) => [citation.id, citation]));
    const strings = getRendererStrings(options.lang ?? 'en');
    const localRef = (id: string): string | undefined => {
        const ref = assets.get(id)?.storageRef;
        if (!ref || /(^\/|\\|^[a-z][a-z\d+.-]*:|(^|\/)\.\.(\/|$))/i.test(ref)) return undefined;
        return destination(ref);
    };
    const image = (id: string, alt?: string): string => {
        const name = assetPresentation(assets.get(id), alt).label;
        const ref = localRef(id);
        return ref ? `![${escapeText(name)}](${ref})` : `[Image unavailable: ${escapeText(name)}]`;
    };
    const citation = (id: string, label?: string): string => {
        const c = citations.get(id);
        const index = bundle.citations.findIndex((entry) => entry.id === id) + 1;
        const name = escapeText(citationDisplayLabel(c, index || 1, label));
        const url = c?.url && destination(c.url);
        return url ? `[${name}](${url})` : `[${name}]`;
    };
    const inline = (node: InlineNode, tableCell = false): string => {
        switch (node.type) {
            case 'text': return escapeText(node.text);
            case 'strong': return `**${inlines(node.children, tableCell)}**`;
            case 'emphasis': return `*${inlines(node.children, tableCell)}*`;
            case 'strikethrough': return `~~${inlines(node.children, tableCell)}~~`;
            case 'inlineCode': {
                // GFM splits a pipe preceded by an even backslash run even inside code spans.
                // Use standard inline HTML only for that table-cell edge case.
                if (tableCell && /\\+\|/.test(node.code)) {
                    const text = node.code.replace(/[&<>\\|`*_{}\[\]]/g, (c) => `&#${c.charCodeAt(0)};`);
                    return `<code>${text}</code>`;
                }
                return codeSpan(node.code);
            }
            case 'link': {
                const url = destination(node.href);
                return url ? `[${inlines(node.children, tableCell)}](${url})` : inlines(node.children, tableCell);
            }
            case 'image': return image(node.assetId, node.alt);
            case 'inlineMath': return `$${node.source}$`;
            case 'citationRef': return citation(node.citationId, node.label);
            case 'lineBreak': return node.kind === 'hard' ? '  \n' : '\n';
        }
    };
    const inlines = (nodes: InlineNode[], tableCell = false): string => nodes.map((node) => inline(node, tableCell)).join('');
    const blocks = (nodes: BlockNode[]): string => nodes.map(block).join('\n\n');
    const block = (node: BlockNode): string => {
        switch (node.type) {
            case 'paragraph': return inlines(node.children);
            case 'heading': return `${'#'.repeat(node.level)} ${inlines(node.children)}`;
            case 'list': return node.items.map((item, index) => {
                const marker = node.ordered ? `${(node.start ?? 1) + index}. ` : '- ';
                const content = blocks(item.blocks).split('\n');
                return marker + content.map((line, n) => n ? ' '.repeat(marker.length) + line : line).join('\n');
            }).join('\n');
            case 'quote': return blocks(node.blocks).split('\n').map((line) => `> ${line}`).join('\n');
            case 'code': {
                const fence = '`'.repeat(Math.max(2, ...(node.code.match(/`+/g) ?? []).map((run) => run.length)) + 1);
                const label = [node.filename, node.meta].filter(Boolean).join(' · ');
                const language = (node.language ?? '').replace(/[\r\n`]/g, '');
                return `${label ? `**${escapeText(label)}**\n\n` : ''}${fence}${language}\n${node.code}\n${fence}`;
            }
            case 'math': return `$$\n${node.source}\n$$`;
            case 'table': {
                const allRows = [...(node.headerRows ?? []), ...node.rows];
                const width = Math.max(node.columns?.length ?? 0, ...allRows.map((row) => row.cells.reduce((n, cell) => n + (cell.colSpan ?? 1), 0)), 1);
                const row = (cells: typeof node.rows[number]['cells']): string => {
                    const values = cells.flatMap((cell) => [inlines(cell.children, true).split('|').join('\\|').replace(/\r?\n/g, '<br>'), ...Array(Math.max(0, (cell.colSpan ?? 1) - 1)).fill('')]);
                    return `| ${Array.from({ length: width }, (_, i) => values[i] ?? '').join(' | ')} |`;
                };
                const header = node.headerRows?.[0];
                const separator = `| ${Array.from({ length: width }, (_, i) => {
                    const align = node.columns?.[i]?.align;
                    return align === 'left' ? ':---' : align === 'center' ? ':---:' : align === 'right' ? '---:' : '---';
                }).join(' | ')} |`;
                const body = [...(node.headerRows?.slice(1) ?? []), ...node.rows].map((r) => row(r.cells));
                return [node.caption ? inlines(node.caption) + '\n' : undefined, row(header?.cells ?? []), separator, ...body].filter((v) => v !== undefined).join('\n');
            }
            case 'image': {
                const caption = assetPresentation(assets.get(node.assetId), assetCaptionText(node.caption) ?? node.alt).caption;
                return [image(node.assetId, node.alt), caption && (node.caption?.length && caption !== assets.get(node.assetId)?.name ? inlines(node.caption) : escapeText(caption))].filter(Boolean).join('\n\n');
            }
            case 'file': {
                const asset = assets.get(node.assetId);
                const name = assetPresentation(asset, node.label, 'Attachment').label;
                const ref = localRef(node.assetId);
                const link = ref ? `[${escapeText(name)}](${ref})` : `[Attachment unavailable: ${escapeText(name)}]`;
                return [link, node.description && inlines(node.description)].filter(Boolean).join('\n\n');
            }
            case 'thought': {
                const label = node.kind === 'summary' ? strings.thinkingSummary : node.kind === 'progress' ? strings.thinkingProgress : strings.thinkingProcess;
                return `<details>\n<summary>🧠 ${label}</summary>\n\n${blocks(node.blocks)}\n\n</details>`;
            }
            case 'thematicBreak': return '---';
            case 'unknown': return `Unsupported · ${escapeText(node.sourceType)}\n\n${escapeText(node.text)}`;
        }
    };
    const title = (conversation.title || conversation.key.conversationId).replace(/[\r\n]+/g, ' ').trim();
    const yaml = (key: string, value: string): string => `${key}: ${JSON.stringify(value)}`;
    const header = [
        '---', yaml('title', title), yaml('id', conversation.key.conversationId), yaml('provider', conversation.key.providerId),
        conversation.url ? yaml('url', conversation.url) : undefined,
        conversation.createdAt ? yaml('date', conversation.createdAt) : undefined,
        conversation.updatedAt ? yaml('updated', conversation.updatedAt) : undefined,
        yaml('exported', new Date().toISOString()), 'tags:', `  - ${conversation.key.providerId}-export`, '---', '', `# ${escapeText(title)}`,
    ].filter((value) => value !== undefined).join('\n');
    const roleHeadings: Record<MessageRole, string> = {
        user: '## 👤 You', assistant: '## 🤖 Assistant', system: '## ⚙️ System', developer: '## 🛠 Developer', unknown: '## Message',
    };
    const messages = conversation.messages.map((message) => {
        const sources = message.citationIds?.length ? ['> 🌐 **Sources:**', ...message.citationIds.map((id, index) => `> [${index + 1}] ${citation(id)}`)].join('\n') : undefined;
        return [roleHeadings[message.role], blocks(message.blocks), sources].filter(Boolean).join('\n\n');
    });
    return [header, ...messages].join('\n\n') + '\n';
}
