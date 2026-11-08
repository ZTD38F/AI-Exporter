import {
    BuilderElement, Document, ExternalHyperlink, HeadingLevel, ImageRun, LevelFormat, Packer, Paragraph, Table, TableCell, TableRow, TextRun, TableLayoutType, WidthType,
    type FileChild, type ParagraphChild, type NumberingDefinition,
} from 'docx';
import type { DisplayBlock, DisplayInline, DocumentAst } from '../../../l3b/ast/ast.js';
import type { ResourceBindings } from '../../packaging/resourceBindings.js';
import type { PreparedResources } from '../../../shared/resources/resourceResult.js';
import type { RendererOptions } from '../shared/renderOptions.js';
import { headerMetadata, messageLabel, sourceLabel, unavailableResourceText } from '../shared/backendPresentation.js';
import { getRendererStrings } from '../shared/renderStrings.js';
import { safeExternalHref } from '../shared/safeLinks.js';
import { docxImageInfo } from '../../shared/docxImageType.js';

import { docxMathWidth, renderDocxMath } from './math.js';

interface InlineStyle { bold?: boolean; italics?: boolean; strike?: boolean; code?: boolean; link?: boolean; size?: number }

function textRun(text: string, style: InlineStyle = {}): TextRun {
    return new TextRun({
        text, bold: style.bold, italics: style.italics, strike: style.strike,
        ...(style.code ? { font: 'Courier New', size: style.size ?? 19 } : {}),
        ...(style.link ? { color: '2563EB', underline: {} } : {}),
    });
}

const PAGE_WIDTH = 9360; // Letter, 1in margins, in twips.

function inlineWidth(nodes: readonly DisplayInline[]): number {
    return Math.max(0, ...nodes.map(node => {
        switch (node.type) {
            case 'inlineMath': return docxMathWidth(node.source) * 20;
            case 'strong': case 'emphasis': case 'strikethrough': case 'link': return inlineWidth(node.children);
            case 'text': case 'citation': case 'inlineCode': {
                const text = node.type === 'text' ? node.text : node.type === 'citation' ? node.label : node.code;
                return Math.max(0, ...text.split(/\s+/u).map(word => [...word].length * 120));
            }
            case 'image': return 2400;
            case 'lineBreak': return 0;
        }
    }));
}

/** Pure format projection from trusted Document AST + prepared L4 bytes; no source reinterpretation. */
export async function renderDocumentDocx(
    document: DocumentAst,
    resources: ResourceBindings,
    prepared: PreparedResources,
    options: RendererOptions = {},
): Promise<Uint8Array> {
    let listId = 0;
    const locale = options.locale ?? 'en';
    const strings = getRendererStrings(locale);
    const image = (resourceId: string, alt: string): ParagraphChild => {
        const resource = prepared.get(resourceId);
        const path = resources[resourceId];
        if (!resource?.ok || !path) {
            return textRun(unavailableResourceText('image', alt || resourceId, locale, options.resourceFailures?.[resourceId]));
        }
        const info = docxImageInfo(resource.value.mediaType, resource.value.bytes);
        if (!info) {
            return textRun((locale === 'zh' ? '图片附件：' : 'Image attachment: ') + (alt || resourceId) + ' (' + path + ')');
        }
        const { width, height } = info;
        const scale = Math.min(1, 520 / width, 610 / height);
        return new ImageRun({
            type: info.type, data: resource.value.bytes,
            transformation: { width: Math.round(width * scale), height: Math.round(height * scale) },
            altText: { name: alt || 'Image', title: alt || 'Image', description: alt || 'Image' },
        });
    };
    const hyperlink = (href: string, children: ParagraphChild[]): ParagraphChild[] => {
        const url = safeExternalHref(href);
        return url ? [new ExternalHyperlink({ link: url, children })] : children;
    };
    const inlines = (nodes: readonly DisplayInline[], style: InlineStyle = {}): ParagraphChild[] =>
        nodes.flatMap((node): ParagraphChild[] => {
            switch (node.type) {
                case 'text': return [textRun(node.text, style)];
                case 'strong': return inlines(node.children, { ...style, bold: true });
                case 'emphasis': return inlines(node.children, { ...style, italics: true });
                case 'strikethrough': return inlines(node.children, { ...style, strike: true });
                case 'inlineCode': return [textRun(node.code, { ...style, code: true })];
                case 'inlineMath': return [renderDocxMath(node.source, false) ?? textRun(node.source, { ...style, code: true })];
                case 'citation': return node.href
                    ? hyperlink(node.href, [textRun(node.label, { ...style, link: true })])
                    : [textRun(node.label, style)];
                case 'link': {
                    const url = safeExternalHref(node.href);
                    const children = inlines(node.children, url ? { ...style, link: true } : style);
                    return url ? [new ExternalHyperlink({ link: url, children })] : children;
                }
                case 'image': return [image(node.resourceId, node.alt)];
                case 'lineBreak': return [new TextRun({ text: '', break: 1 })];
            }
        });
    const p = (children: ParagraphChild[], style?: string): Paragraph =>
        new Paragraph({ children, ...(style ? { style } : {}) });
    const table = (node: Extract<DisplayBlock, { type: 'table' }>): FileChild[] => {
        const rows = [...node.headerRows, ...node.rows];
        if (!rows.length) return [p([textRun('')])];
        const columns = Math.max(...rows.flatMap(row => row.map(cell => cell.column + cell.colSpan)));
        const minimums = Array.from({ length: columns }, () => 600);
        for (const row of rows) for (const cell of row) {
            const width = (inlineWidth(cell.children) + 320) / cell.colSpan;
            for (let c = cell.column; c < cell.column + cell.colSpan; c++) minimums[c] = Math.max(minimums[c], width);
        }
        const total = minimums.reduce((a, b) => a + b, 0);
        const caption = node.caption ? [p(inlines(node.caption), 'Caption')] : [];
        if (total > PAGE_WIDTH) {
            // A formula cannot wrap like prose inside a narrow Word cell.
            // Expand the grid into labelled records rather than hiding its tail.
            return [...caption, ...rows.flatMap((cells, index) => [
                new Paragraph({
                    text: index < node.headerRows.length
                        ? (locale === 'zh' ? '表头 ' : 'Header ') + (index + 1)
                        : (locale === 'zh' ? '行 ' : 'Row ') + (index - node.headerRows.length + 1),
                    keepNext: true, spacing: { before: 120 },
                }),
                ...cells.flatMap(cell => {
                    const labels = node.headerRows.flatMap(row => row.filter(header =>
                        header.column < cell.column + cell.colSpan && header.column + header.colSpan > cell.column));
                    return [
                        new Paragraph({
                            children: labels.length && index >= node.headerRows.length
                                ? labels.flatMap((label, i) => [...(i ? [textRun(' / ')] : []), ...inlines(label.children, { bold: true })])
                                : [textRun((locale === 'zh' ? '列 ' : 'Column ') + (cell.column + 1)
                                    + (cell.colSpan > 1 ? '–' + (cell.column + cell.colSpan) : ''), { bold: true })],
                            keepNext: true,
                        }),
                        p(inlines(cell.children)),
                        ...(cell.rowSpan > 1 ? [p([textRun((locale === 'zh' ? '跨行：' : 'Row span: ') + cell.rowSpan)])] : []),
                    ];
                }),
            ])];
        }
        const widths = minimums.map(width => Math.floor(width * PAGE_WIDTH / total));
        return [...caption, new Table({
            width: { size: PAGE_WIDTH, type: WidthType.DXA }, columnWidths: widths, layout: TableLayoutType.FIXED,
            rows: rows.map((cells, index) => new TableRow({
                tableHeader: index < node.headerRows.length, cantSplit: true,
                children: cells.map(cell => new TableCell({
                    width: { size: widths.slice(cell.column, cell.column + cell.colSpan).reduce((a, b) => a + b, 0), type: WidthType.DXA },
                    children: [p(inlines(cell.children, index < node.headerRows.length ? { bold: true } : {}))],
                    ...(cell.colSpan > 1 ? { columnSpan: cell.colSpan } : {}),
                    ...(cell.rowSpan > 1 ? { rowSpan: cell.rowSpan } : {}),
                })),
            })),
        })];
    };
    const blocks = (nodes: readonly DisplayBlock[], depth = 0, quote = false): FileChild[] =>
        nodes.flatMap(node => {
            switch (node.type) {
                case 'paragraph': return [new Paragraph({
                    children: inlines(node.children), ...(quote ? { style: 'Quote' } : {}),
                    ...(depth > 0 ? { indent: { left: 540 + Math.min(depth - 1, 8) * 360 } } : {}),
                })];
                case 'heading': {
                    const heading = [
                        HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
                        HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6,
                    ][node.level - 1];
                    return [new Paragraph({ children: inlines(node.children), heading, keepNext: true })];
                }
                case 'list': {
                    const level = Math.min(depth, 8); // OOXML allows nine numbering levels.
                    const reference: NumberingDefinition = {
                        reference: `docx-list-${listId++}`,
                        levels: [{
                            level, format: node.ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
                            text: node.ordered ? `%${level + 1}.` : '•',
                            start: node.ordered ? node.start ?? 1 : 1,
                            style: { paragraph: { indent: { left: 540 + level * 360, hanging: 300 } } },
                        }],
                    };
                    return node.items.flatMap(item => {
                        const first = item.blocks[0];
                        return [new Paragraph({
                            children: first?.type === 'paragraph' ? inlines(first.children) : [],
                            numbering: { reference, level },
                            ...(quote ? { style: 'Quote' } : {}),
                        }), ...blocks(first?.type === 'paragraph' ? item.blocks.slice(1) : item.blocks, depth + 1, quote)];
                    });
                }
                case 'quote': return blocks(node.blocks, depth, true);
                case 'code': {
                    const lines = node.code.replace(/\r\n?/g, '\n').split('\n');
                    const indent = depth > 0 ? 540 + Math.min(depth - 1, 8) * 360 : 200;
                    const longest = Math.max(1, ...lines.map(line => [...line.replace(/\t/g, '    ')].length));
                    const size = Math.max(14, Math.min(19, Math.floor((PAGE_WIDTH - indent) / (longest * 6))));
                    return lines.map((line, index) => new Paragraph({
                        children: [textRun(line.replace(/\t/g, '    '), { code: true, size })],
                        shading: { fill: 'F3F6FA' }, spacing: { after: 0 },
                        keepNext: lines.length <= 35 && index < lines.length - 1,
                        indent: { left: indent },
                    }));
                }
                case 'math': {
                    const math = renderDocxMath(node.source, true);
                    if (math) {
                        const paragraph = new Paragraph({ alignment: 'center' });
                        paragraph.addChildElement(new BuilderElement({ name: 'm:oMathPara', children: [math] }));
                        return [paragraph];
                    }
                    return [
                        p([textRun(strings.mathFallback, { italics: true })], 'Caption'),
                        p([textRun(node.source, { code: true })]),
                    ];
                }
                case 'table': return table(node);
                case 'image': return [
                    p([image(node.resourceId, node.alt)]),
                    ...(node.caption ? [p(inlines(node.caption), 'Caption')] : []),
                ];
                case 'file': return [
                    p([textRun((locale === 'zh' ? '附件：' : 'Attachment: ') + node.label
                        + (resources[node.resourceId] ? ' (' + resources[node.resourceId] + ')' : ''))]),
                    ...(node.description ? [p(inlines(node.description), 'Caption')] : []),
                ];
                case 'disclosure': return [
                    new Paragraph({ text: node.title, heading: HeadingLevel.HEADING_3, keepNext: true }),
                    ...blocks(node.blocks, depth, quote),
                ];
                case 'thematicBreak': return [p([textRun('________________________________________')], 'Caption')];
                case 'unsupported': return [
                    p([textRun(strings.unsupportedContent + ' · ' + node.sourceType, { bold: true })]),
                    p([textRun(node.text)]),
                ];
            }
        });
    const children: FileChild[] = [
        new Paragraph({ text: document.title, style: 'Title' }),
        new Paragraph({ text: headerMetadata(document, locale), style: 'Subtitle' }),
        ...document.messages.flatMap(message => [
            new Paragraph({ text: messageLabel(message, locale), heading: HeadingLevel.HEADING_2, keepNext: true }),
            ...(message.modelLabel ? [p([textRun(message.modelLabel, { italics: true })], 'Caption')] : []),
            ...blocks(message.blocks),
            ...(message.sources?.length ? [
                p([textRun(strings.sources + ':', { bold: true })], 'Caption'),
                ...message.sources.map(source => p(source.href
                    ? hyperlink(source.href, [textRun(sourceLabel(source), { link: true })])
                    : [textRun(sourceLabel(source))], 'Caption')),
            ] : []),
        ]),
        ...(!document.messages.length ? [p([textRun(strings.emptyConversation)])] : []),
    ];
    const word = new Document({
        styles: { default: { document: { run: { size: 22 } } } },
        sections: [{ properties: { page: {
            size: { width: 12240, height: 15840 },
            margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 },
        } }, children }],
    });
    return new Uint8Array(await (await Packer.toBlob(word)).arrayBuffer());
}
