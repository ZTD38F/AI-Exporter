import { resourceFailureText, type ResourceFailure } from '../../../shared/resources/resourceResult.js';
import type { DisplayBlock, DisplayInline, DisplayMessage, DocumentAst, SourceItem } from '../../../l3b/ast/ast.js';
import { getRendererStrings } from './renderStrings.js';

export function inlineText(node: DisplayInline): string {
    if ('children' in node) return node.children.map(inlineText).join('');
    switch (node.type) {
        case 'text': return node.text;
        case 'inlineCode': return node.code;
        case 'citation': return node.label;
        case 'image': return node.alt;
        case 'inlineMath': return node.source;
        case 'lineBreak': return '\n';
    }
}
export function blockText(node: DisplayBlock): string {
    switch (node.type) {
        case 'paragraph': case 'heading': return node.children.map(inlineText).join('');
        case 'list': return node.items.map(item => item.blocks.map(blockText).join('\n')).join('\n');
        case 'quote': case 'disclosure': return node.blocks.map(blockText).join('\n');
        case 'code': return node.code;
        case 'math': return node.source;
        case 'table': return [...node.headerRows, ...node.rows].map(row => row.map(cell => cell.children.map(inlineText).join('')).join(' | ')).join('\n');
        case 'image': return node.alt;
        case 'file': return node.label;
        case 'unsupported': return node.text;
        case 'thematicBreak': return '';
    }
}
export function codeHeader(node: Extract<DisplayBlock, { type: 'code' }>, format: 'html' | 'markdown' | 'pdf'): string {
    if (format === 'markdown') return node.meta ?? '';
    const language = node.language || 'text';
    const title = language;
    return title + (format === 'pdf' && node.meta ? ` · ${node.meta}` : '');
}
const mediaBadges: Readonly<Record<string, string>> = {
    'application/pdf': 'PDF',
    'application/msword': 'DOC',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
    'application/vnd.ms-word.document.macroenabled.12': 'DOCM',
    'application/vnd.ms-excel': 'XLS',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
    'application/vnd.ms-excel.sheet.macroenabled.12': 'XLSM',
    'application/vnd.ms-powerpoint': 'PPT',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PPTX',
    'application/vnd.ms-powerpoint.presentation.macroenabled.12': 'PPTM',
    'application/vnd.oasis.opendocument.text': 'ODT',
    'application/vnd.oasis.opendocument.spreadsheet': 'ODS',
    'application/vnd.oasis.opendocument.presentation': 'ODP',
    'application/rtf': 'RTF', 'text/rtf': 'RTF',
    'text/plain': 'TXT', 'text/markdown': 'MD', 'text/csv': 'CSV', 'text/tab-separated-values': 'TSV',
    'application/json': 'JSON', 'application/xml': 'XML', 'text/xml': 'XML', 'text/html': 'HTML',
    'application/zip': 'ZIP', 'application/x-zip': 'ZIP', 'application/x-zip-compressed': 'ZIP',
    'application/gzip': 'GZ', 'application/x-gzip': 'GZ', 'application/x-tar': 'TAR',
    'application/x-7z-compressed': '7Z', 'application/vnd.rar': 'RAR', 'application/x-rar-compressed': 'RAR',
    'image/png': 'PNG', 'image/jpeg': 'JPG', 'image/gif': 'GIF', 'image/webp': 'WEBP',
    'image/svg+xml': 'SVG', 'image/avif': 'AVIF', 'image/heic': 'HEIC', 'image/bmp': 'BMP', 'image/tiff': 'TIFF',
    'audio/mpeg': 'MP3', 'audio/wav': 'WAV', 'audio/x-wav': 'WAV', 'audio/mp4': 'M4A', 'audio/ogg': 'OGG',
    'video/mp4': 'MP4', 'video/webm': 'WEBM', 'video/quicktime': 'MOV',
};
const kindBadges: Readonly<Record<string, string>> = {
    file: 'FILE', image: 'IMAGE', audio: 'AUDIO', video: 'VIDEO',
    ...Object.fromEntries(Object.values(mediaBadges).map(badge => [badge.toLowerCase(), badge])),
};

/** Display authored type facts; filenames and arbitrary MIME subtypes are not badges. */
export function fileBadge(node: Extract<DisplayBlock, { type: 'file' }>): string {
    const mediaType = node.mediaType?.split(';')[0].trim().toLowerCase();
    const kind = node.kind.trim().toLowerCase();
    const category = mediaType?.split('/')[0] ?? '';
    return (mediaType && Object.hasOwn(mediaBadges, mediaType) && mediaBadges[mediaType]) || (Object.hasOwn(kindBadges, kind) && kindBadges[kind])
        || (['image', 'audio', 'video'].includes(category) ? kindBadges[category] : 'FILE');
}
export function humanBytes(value: number | undefined, unknown: string): string {
    if (value == null || !Number.isFinite(value) || value < 0) return unknown;
    if (value < 1024) return `${value} B`;
    const units = ['KB', 'MB', 'GB', 'TB']; let n = value / 1024; let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n >= 10 ? n.toFixed(1) : n.toFixed(2)} ${units[i]}`;
}
export function headerMetadata(document: DocumentAst, locale: 'zh' | 'en', pdf = false): string {
    const strings = getRendererStrings(locale);
    const time = document.metadata.updatedAt ?? document.metadata.createdAt;
    const date = time === undefined ? undefined : new Date(time).toISOString().slice(0, 10);
    return document.metadata.provider + (date ? ' · ' + date : pdf ? ' · ' + strings.dateUnknown : '')
        + ' · ' + document.messages.length + ' ' + (pdf || locale === 'en' ? 'messages' : '条消息');
}
export function messageLabel(message: DisplayMessage, locale: 'zh' | 'en'): string {
    return getRendererStrings(locale).roles[message.role];
}

/** Preserve Composer numbering, including the numeric label used for untitled sources. */
export function sourceLabel(item: SourceItem): string {
    return sourceNumberPrefix(item) + item.label;
}

export function sourceNumberPrefix(item: SourceItem): string {
    return item.label === '[' + item.number + ']' ? '' : '[' + item.number + ']' + (item.label ? ' ' : '');
}

export function unavailableResourceText(kind: 'image' | 'file', label: string, locale: 'zh' | 'en', failure?: ResourceFailure): string {
    if (failure) return resourceFailureText(failure, locale) + (label ? `: ${label}` : '');
    const strings = getRendererStrings(locale);
    const text = kind === 'image' ? strings.imageUnavailable : strings.fileUnavailable;
    return label ? `${text}: ${label}` : text;
}
