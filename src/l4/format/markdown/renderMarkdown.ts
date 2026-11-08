import { codeHeader, messageLabel, sourceNumberPrefix, unavailableResourceText } from '../shared/backendPresentation.js';
import { getRendererStrings } from '../shared/renderStrings.js';
import { isResourcePath } from '../shared/resourcePath.js';
import { safeExternalHref, encodeResourceHref, encodeMarkdownHref } from '../shared/safeLinks.js';
import type { RendererOptions } from '../shared/renderOptions.js';
import type { DisplayBlock, DisplayCell, DisplayInline, DocumentAst } from '../../../l3b/ast/ast.js';
import type { ResourceBindings } from '../../packaging/resourceBindings.js';
import { inlineMathMarkdown } from '../../../shared/utils/markdownMath.js';

const htmlEntities: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const htmlEntity = (char: string): string => htmlEntities[char] ?? char;

function escapeText(text: string): string {
    return text.replace(/\\/g, '\\\\').replace(/[&<>]/g, htmlEntity)
        .replace(/([`*_\[\]#~$])/g, '\\$1').replace(/^(\s*)([-+] |\d+[.)] )/gm, (_, space: string, marker: string) => space + marker.replace(/[-+.)]/, '\\$&'));
}

function codeSpan(value: string): string {
    const fence = '`'.repeat(Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length)) + 1);
    const pad = /(^`|`$|^ .* $)/.test(value) ? ' ' : '';
    return `${fence}${pad}${value}${pad}${fence}`;
}

export function renderDocumentMarkdown(document: DocumentAst, resources: ResourceBindings, options: RendererOptions = {}): string {
    const locale = options.locale ?? 'en';
    const strings = getRendererStrings(locale);
    const available = (id: string) => isResourcePath(resources[id]);
    const resource = (id: string): string => {
        const value = resources[id];
        const ref = value && isResourcePath(value) ? encodeMarkdownHref(encodeResourceHref(value)) : undefined;
        if (!ref) throw new TypeError(`Missing prepared resource binding: ${id}`);
        return ref;
    };
    const sourceLink = (id: string): string => {
        const url = safeExternalHref(options.resourceFailures?.[id]?.sourceUrl ?? '');
        return url ? ` [${locale === 'zh' ? '查看来源' : 'Open source'}](${encodeMarkdownHref(url)})` : '';
    };
    const placeholder = (node: { text: string; kind: 'image' | 'file'; id: string }): string =>
        `[${escapeText(unavailableResourceText(node.kind, node.text, locale, options.resourceFailures?.[node.id]))}]` + sourceLink(node.id);
    const image = (id: string, alt: string): string => available(id) ? `![${escapeText(alt)}](${resource(id)})` : placeholder({ kind: 'image', text: alt || id, id });
    const citation = (node: { label: string; href?: string }): string => {
        const url = node.href && safeExternalHref(node.href);
        return url ? `[${escapeText(node.label)}](${encodeMarkdownHref(url)})` : /^\[\d+\]$/.test(node.label) ? escapeText(node.label) : `[${escapeText(node.label)}]`;
    };
    const inline = (node: DisplayInline, tableCell = false): string => {
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
                const url = safeExternalHref(node.href);
                return url ? `[${inlines(node.children, tableCell)}](${encodeMarkdownHref(url)})` : inlines(node.children, tableCell);
            }
            case 'image': return image(node.resourceId, node.alt);
            case 'inlineMath': {
                // GFM escapes a pipe before inline math is parsed. Spell bars
                // as TeX commands in cells to preserve norms and table columns.
                const source = tableCell ? node.source.replace(/(\\*)\|/g, (_match, slashes: string) =>
                    slashes.length % 2 ? slashes.slice(0, -1) + '\\Vert{}' : slashes + '\\vert{}') : node.source;
                return inlineMathMarkdown(source);
            }
            case 'citation': return citation(node);
            case 'lineBreak': return node.kind === 'hard' ? '  \n' : '\n';
        }
    };
    const inlines = (nodes: DisplayInline[], tableCell = false): string => nodes.map((node) => inline(node, tableCell)).join('');
    // GFM cannot express merged table cells. Use safe HTML for such tables,
    // preserving cell spans and readable content rather than flattening them.
    const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, htmlEntity);
    const htmlInline = (node: DisplayInline): string => {
        switch (node.type) {
            case 'text': return escapeHtml(node.text);
            case 'strong': return '<strong>' + htmlInlines(node.children) + '</strong>';
            case 'emphasis': return '<em>' + htmlInlines(node.children) + '</em>';
            case 'strikethrough': return '<del>' + htmlInlines(node.children) + '</del>';
            case 'inlineCode': return '<code>' + escapeHtml(node.code) + '</code>';
            case 'link': {
                const href = safeExternalHref(node.href);
                return href ? '<a href="' + escapeHtml(href) + '">' + htmlInlines(node.children) + '</a>' : htmlInlines(node.children);
            }
            case 'citation': {
                const href = safeExternalHref(node.href);
                return href ? '<a href="' + escapeHtml(href) + '">' + escapeHtml(node.label) + '</a>' : escapeHtml(node.label);
            }
            case 'image':
                return available(node.resourceId) ? '<img src="' + escapeHtml(resource(node.resourceId)) + '" alt="' + escapeHtml(node.alt) + '">'
                    : escapeHtml(unavailableResourceText('image', node.alt || node.resourceId, locale, options.resourceFailures?.[node.resourceId]));
            case 'inlineMath': return '<code>' + escapeHtml(node.source) + '</code>';
            case 'lineBreak': return '<br>';
        }
    };
    const htmlInlines = (nodes: DisplayInline[]): string => nodes.map(htmlInline).join('');
    const mergedTableHtml = (node: Extract<DisplayBlock, { type: 'table' }>): string => {
        const row = (cells: DisplayCell[], heading: boolean): string =>
            '<tr>' + cells.map(cell => {
                const tag = heading ? 'th' : 'td';
                const attrs = (cell.colSpan > 1 ? ' colspan="' + cell.colSpan + '"' : '')
                    + (cell.rowSpan > 1 ? ' rowspan="' + cell.rowSpan + '"' : '');
                return '<' + tag + attrs + '>' + htmlInlines(cell.children) + '</' + tag + '>';
            }).join('') + '</tr>';
        return [
            '<table>',
            ...(node.caption ? ['<caption>' + htmlInlines(node.caption) + '</caption>'] : []),
            ...(node.rows.length && node.headerRows.some((cells, index) =>
                cells.some(cell => index + cell.rowSpan > node.headerRows.length))
                ? ['<tbody>', ...node.headerRows.map(cells => row(cells, true)), ...node.rows.map(cells => row(cells, false)), '</tbody>']
                : [...(node.headerRows.length ? ['<thead>', ...node.headerRows.map(cells => row(cells, true)), '</thead>'] : []),
                    '<tbody>', ...node.rows.map(cells => row(cells, false)), '</tbody>']),
            '</table>',
        ].join('\n');
    };
    const blocks = (nodes: DisplayBlock[]): string => nodes.map(block).join('\n\n');
    const block = (node: DisplayBlock): string => {
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
                const label = codeHeader(node, 'markdown');
                const language = (node.language ?? '').replace(/[\r\n`]/g, '');
                const end = node.code.endsWith('\n') ? '' : '\n';
                return `${label ? `**${escapeText(label)}**\n\n` : ''}${fence}${language}\n${node.code}${end}${fence}`;
            }
            case 'math': {
                const longestDollarRun = (node.source.match(/\$+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 1);
                const fence = '$'.repeat(Math.max(2, longestDollarRun + 1));
                return `${fence}\n${node.source}\n${fence}`;
            }
            case 'table': {
                if ([...node.headerRows, ...node.rows].some(cells => cells.some(cell => cell.colSpan > 1 || cell.rowSpan > 1))) {
                    return mergedTableHtml(node);
                }
                const row = (cells: DisplayCell[]): string => `| ${cells.map(cell => inlines(cell.children, true).split('|').join('\\|').replace(/\r?\n/g, '<br>')).join(' | ')} |`;
                const separator = `| ${node.columnAlignments.map(align => align === 'left' ? ':---' : align === 'center' ? ':---:' : align === 'right' ? '---:' : '---').join(' | ')} |`;
                const projected = projectedTable(node);
                return [node.caption ? inlines(node.caption) + '\n' : undefined, row(projected[0]), separator, ...projected.slice(1).map(row)].filter(value => value !== undefined).join('\n');
            }
            case 'image': {
                return [image(node.resourceId, node.alt), node.caption && inlines(node.caption)].filter(Boolean).join('\n\n');
            }
            case 'file': return [available(node.resourceId) ? `[${escapeText(node.label)}](${resource(node.resourceId)})` : placeholder({ kind: 'file', text: node.label, id: node.resourceId }), node.description && inlines(node.description)].filter(Boolean).join('\n\n');
            case 'disclosure': return `<details>\n<summary>${escapeText(node.title)}</summary>\n\n${blocks(node.blocks)}\n\n</details>`;
            case 'thematicBreak': return '---';
            case 'unsupported': return `${escapeText(`${strings.unsupportedContent} · ${node.sourceType}`)}\n\n${escapeText(node.text)}`;
        }
    };
    const metadata = document.metadata;
    if (!metadata) throw new TypeError('Markdown document metadata is required');
    const entries: Array<{ key: string; value: string | string[] }> = [
        { key: 'title', value: document.title }, { key: 'id', value: metadata.id }, { key: 'provider', value: metadata.provider },
        ...(metadata.createdAt !== undefined ? [{ key: 'date', value: new Date(metadata.createdAt).toISOString() }] : []),
        ...(metadata.updatedAt !== undefined ? [{ key: 'updated', value: new Date(metadata.updatedAt).toISOString() }] : []),
        { key: 'tags', value: [`${metadata.provider}-export`] },
    ];
    const yaml = entries.map(entry => {
        if (!/^[a-z][a-z\d_-]*$/i.test(entry.key)) throw new TypeError('Invalid front matter key');
        return Array.isArray(entry.value)
        ? `${entry.key}:\n${entry.value.map(value => `  - ${/^[a-z][a-z\d_-]*$/i.test(value) && !/^(?:null|true|false|yes|no|on|off)$/i.test(value) ? value : JSON.stringify(value)}`).join('\n')}`
        : `${entry.key}: ${JSON.stringify(entry.value)}`;
    }).join('\n');
    const header = `---\n${yaml}\n---\n\n# ${escapeText(document.title)}`;
    const messages = document.messages.map(message => {
        const icons = { user: '👤', assistant: '🤖', system: '⚙️', developer: '🛠', unknown: '' };
        const heading = `## ${icons[message.role] ? icons[message.role] + ' ' : ''}${escapeText(messageLabel(message, locale))}`;
        const sources = message.sources && [`> 🌐 **${strings.sources}:**`, ...message.sources.map(item => {
            const prefix = sourceNumberPrefix(item);
            return `> ${!item.label && !item.href ? prefix.trimEnd() : !prefix && !item.href ? item.label : prefix + citation(item)}`;
        })].filter(Boolean).join('\n');
        return [heading, message.modelLabel && `*${escapeText(message.modelLabel)}*`, blocks(message.blocks), sources].filter(Boolean).join('\n\n');
    });
    return [header, ...messages, ...(!messages.length ? [strings.emptyConversation] : [])].join('\n\n') + '\n';
}

/** GFM supports one header row and no spans; project without changing the shared tree. */
function projectedTable(node: Extract<DisplayBlock, { type: 'table' }>): DisplayCell[][] {
    const width = node.columnAlignments.length;
    const blank = (column: number): DisplayCell => ({ column, colSpan: 1, rowSpan: 1, children: [] });
    const rows = [...node.headerRows, ...node.rows].map(row => {
        const cells = Array.from({ length: width }, (_, column) => blank(column));
        for (const cell of row) cells[cell.column] = { ...cell, colSpan: 1, rowSpan: 1 };
        return cells;
    });
    return node.headerRows.length ? rows : [Array.from({ length: width }, (_, column) => blank(column)), ...rows];
}
