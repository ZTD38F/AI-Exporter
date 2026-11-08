import { stripHtmlTags as utilsStripHtmlTags } from "../../../../shared/utils/titleText.js";

export const stripHtmlTags = utilsStripHtmlTags;

/**
 * Safely unescapes basic HTML entities in a single pass to prevent double-unescaping vulnerabilities.
 */
function unescapeHtmlEntities(str: string): string {
    if (!str) return '';
    return str.replace(/&(?:amp|lt|gt|quot|#39);/g, (match) => {
        switch (match) {
            case '&amp;': return '&';
            case '&lt;': return '<';
            case '&gt;': return '>';
            case '&quot;': return '"';
            case '&#39;': return "'";
            default: return match;
        }
    });
}

function parseTakeoutPrompt(block: string): { promptText: string; hasExplicitPrompt: boolean } {
    let promptText = '';
    let hasExplicitPrompt = false;
    const promptMatch = block.match(/(?:Prompted|已提示|提示|プロンプト|Demande|Preguntado)\s*([\s\S]*?)(?:<br\s*\/?>|\n)/i);
    if (promptMatch) {
        hasExplicitPrompt = true;
        promptText = stripHtmlTags(promptMatch[1]).replace(/&nbsp;/g, ' ').replace(/[\u202f\xa0]/g, ' ').trim();
    } else {
        const contentCellMatchFallback = block.match(/<div class="content-cell[^>]*>([\s\S]*?)(?:<br\s*\/?>|\n)/i);
        if (contentCellMatchFallback) {
            promptText = stripHtmlTags(contentCellMatchFallback[1]).replace(/&nbsp;/g, ' ').replace(/[\u202f\xa0]/g, ' ').trim();
        }
    }
    return { promptText, hasExplicitPrompt };
}

export function parseTakeoutTimestamp(block: string): number | null {
    let ts: number | null = null;
    const timeMatchEn = block.match(/([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4},\s+\d{1,2}:\d{2}(?::\d{2})?\s*[\u202f\s]*(?:AM|PM)(?:\s+[A-Za-z0-9_+-]+)?)/);
    const timeMatchZh = block.match(/(\d{4}年\d{1,2}月\d{1,2}日[\s\u202f\xa0]*(?:[A-Z]{2,4}\s+)?(?:上午|下午)?\s*\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:UTC|GMT)?\s*[+-]?\d{1,2}(?::?\d{2})?|\s*[A-Z]{2,4})?)/);
    const timeMatchIso = block.match(/(\d{4}[-/]\d{1,2}[-/]\d{1,2}[\sT]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/);

    const hasCjk = /[\u4e00-\u9fa5]/.test(block);
    const tzMap: Record<string, string> = {
        'UTC': '+0000', 'GMT': '+0000',
        'EDT': '-0400', 'EST': '-0500',
        'CDT': '-0500',
        'CST': hasCjk ? '+0800' : '-0600',
        'MDT': '-0600', 'MST': '-0700',
        'PDT': '-0700', 'PST': '-0800',
        'AKDT': '-0800', 'AKST': '-0900',
        'HST': '-1000', 'HDT': '-0900',
        'BST': '+0100', 'CET': '+0100', 'CEST': '+0200',
        'EET': '+0200', 'EEST': '+0300',
        'IST': '+0530', 'JST': '+0900', 'KST': '+0900',
        'AEST': '+1000', 'AEDT': '+1100',
        'SGT': '+0800', 'HKT': '+0800'
    };

    const extractOffset = (text: string) => {
        const numMatch = text.match(/\s+(?:UTC|GMT)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i);
        if (numMatch) {
            const sign = numMatch[1];
            const hours = numMatch[2].padStart(2, '0');
            const mins = (numMatch[3] || '00').padStart(2, '0');
            const clean = text.replace(/\s+(?:UTC|GMT)?\s*[+-]\d{1,2}(?::?\d{2})?$/i, '').trim();
            return { cleanText: clean, offsetStr: ` GMT${sign}${hours}${mins}` };
        }
        const codeMatch = text.match(/\s+([A-Z]{3,4})$/);
        if (codeMatch && tzMap[codeMatch[1]]) {
            const clean = text.replace(/\s+[A-Z]{3,4}$/, '').trim();
            return { cleanText: clean, offsetStr: ' GMT' + tzMap[codeMatch[1]] };
        }
        return { cleanText: text.trim(), offsetStr: '' };
    };

    if (timeMatchEn) {
        const rawT = timeMatchEn[1].replace(/[\u202f\xa0]/g, ' ').trim();
        const { cleanText, offsetStr } = extractOffset(rawT);
        const dt = new Date(cleanText + offsetStr);
        if (!isNaN(dt.getTime())) ts = dt.getTime();
    } else if (timeMatchZh) {
        const rawZh = timeMatchZh[1].replace(/[\u202f\xa0]/g, ' ').trim();
        const { cleanText, offsetStr } = extractOffset(rawZh);
        const isPm = cleanText.includes('下午');
        const isAm = cleanText.includes('上午');
        const parts = cleanText.replace(/上午|下午/g, '').replace(/[A-Z]{2,4}/g, '').trim()
            .match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
        if (parts) {
            const y = parts[1];
            const m = parts[2].padStart(2, '0');
            const d = parts[3].padStart(2, '0');
            let h = parseInt(parts[4], 10);
            const min = parts[5];
            const sec = parts[6] || '00';
            if (isPm && h < 12) h += 12;
            else if (isAm && h === 12) h = 0;
            const dateStr = `${y}-${m}-${d} ${String(h).padStart(2, '0')}:${min}:${sec}${offsetStr}`;
            const dt = new Date(dateStr);
            if (!isNaN(dt.getTime())) ts = dt.getTime();
        }
    } else if (timeMatchIso) {
        const dt = new Date(timeMatchIso[1].replace(/[\u202f\xa0]/g, ' '));
        if (!isNaN(dt.getTime())) ts = dt.getTime();
    }
    return ts;
}


export interface TakeoutActivityEvidence {
    /** Source position, not a fabricated message or document identity. */
    blockIndex: number;
    conversationIds: string[];
    promptText: string;
    hasExplicitPrompt: boolean;
    timestamp: number | null;
    responseHtml: string;
    generatedImageCount?: number;
    media: Array<{ uri: string; owner: 'user' | 'assistant' | 'unknown' }>;
}

function activityContentCell(block: string): string {
    const opening = /<div\b[^>]*class=["'][^"']*\bcontent-cell\b[^"']*["'][^>]*>/i.exec(block);
    if (!opening) return '';
    const start = opening.index + opening[0].length;
    const tags = /<\/?div\b[^>]*>/gi;
    tags.lastIndex = start;
    let depth = 1;
    for (let tag = tags.exec(block); tag; tag = tags.exec(block)) {
        depth += /^<\//.test(tag[0]) ? -1 : 1;
        if (depth === 0) return block.slice(start, tag.index);
    }
    return block.slice(start);
}

function activityBlocks(htmlText: string): string[] {
    if (typeof htmlText !== 'string') throw new TypeError('Takeout input must be HTML text');
    const blocks = htmlText.split('<div class="outer-cell');
    if (blocks.length <= 1) throw new TypeError('Unsupported Takeout MyActivity block format');
    return blocks.slice(1);
}

/** Conversation links inside authored content are references, never an activity owner. */
function activityMetadata(block: string): string {
    const divTags = /<\/?div\b[^>]*>/gi;
    let metadata = '';
    let cursor = 0;
    let contentDepth = 0;
    for (let tag = divTags.exec(block); tag; tag = divTags.exec(block)) {
        const closing = tag[0].startsWith('</');
        if (contentDepth > 0) {
            contentDepth += closing ? -1 : 1;
            if (contentDepth === 0) cursor = divTags.lastIndex;
        } else if (!closing) {
            const classes = /\bclass\s*=\s*(['"])(.*?)\1/i.exec(tag[0])?.[2] ?? '';
            const classNames = classes.split(/\s+/);
            // Google Takeout puts the canonical Conversation URL in a caption
            // content-cell, separate from the user/assistant authored body.
            // Preserve this metadata cell but exclude every non-caption cell,
            // including ordinary links to other chats inside their text.
            if (classNames.includes('content-cell') && !classNames.includes('mdl-typography--caption')) {
                metadata += block.slice(cursor, tag.index);
                contentDepth = 1;
            }
        }
    }
    if (contentDepth === 0) metadata += block.slice(cursor);
    return metadata;
}

function decodeActivityBlock(block: string, index: number): TakeoutActivityEvidence {
    const metadata = activityMetadata(block);
    const metadataIds = [...new Set(Array.from(metadata.matchAll(/https:\/\/(?:gemini|bard)\.google\.com\/(?:u\/\d+\/)?(?:app|chat)\/([a-zA-Z0-9_-]{8,64})/g),
        match => match[1].replace(/^c_/, '')))];
    // No unverified event may be copied into several conversations.
    if (metadataIds.length > 1) console.warn(`[Gemini Exporter] Takeout activity ${index + 1} has ambiguous conversation metadata; skipping it`);
    const conversationIds = metadataIds.length === 1 ? metadataIds : [];
    const { promptText, hasExplicitPrompt } = parseTakeoutPrompt(block);
    const generated = /(?:(\d+)\s*generated images?|(\d+)\s*张生成的图片)/i.exec(block);
    const rawCell = activityContentCell(block);
    const parts = rawCell.split(/<br\s*\/?>|\n/);
    const start = parts.findIndex(part => !/(?:Prompted|已提示|提示|プロンプト|Demande|Preguntado)/i.test(part) && /<(?:p|pre|table|h[1-6]|ul|ol|strong|em|code|img)\b/i.test(part));
    const responseHtml = start === -1 ? '' : parts.slice(start).join('\n').trim();
    const cellOffset = rawCell ? block.indexOf(rawCell) : -1;
    const responseOffset = start === -1 ? rawCell.length : rawCell.indexOf(parts[start]);
    const responseStart = cellOffset < 0 ? block.length : cellOffset + responseOffset;
    const cellEnd = cellOffset + rawCell.length;
    const media: TakeoutActivityEvidence['media'] = [];
    for (const match of block.matchAll(/(?:src|href)=["']([^#"'>]+?)["']/gi)) {
        const uri = unescapeHtmlEntities(match[1]).trim();
        if (/^(?:https?:|\/\/|javascript:|mailto:|data:)/i.test(uri) || /\.html?$/i.test(uri)) continue;
        const position = match.index;
        const inPromptCell = hasExplicitPrompt && cellOffset >= 0 && position >= cellOffset && position < responseStart;
        const inAttachedSection = /Attached\s+\d+\s+files?/i.test(block.slice(0, position)) && position < responseStart;
        const inResponse = start !== -1 && cellOffset >= 0 && position >= responseStart && position < cellEnd;
        const owner = inPromptCell || inAttachedSection ? 'user' : inResponse ? 'assistant' : 'unknown';
        if (!media.some(m => m.uri === uri && m.owner === owner)) media.push({ uri, owner });
    }
    return { blockIndex: index + 1, conversationIds, promptText, hasExplicitPrompt,
        timestamp: parseTakeoutTimestamp(block), responseHtml,
        ...(generated ? { generatedImageCount: Number(generated[1] || generated[2]) } : {}), media };
}

/** One grammar is shared by synchronous HTML and cooperative asynchronous ZIP parsing. */
export function decodeTakeoutHtml(htmlText: string): TakeoutActivityEvidence[] {
    return activityBlocks(htmlText).map(decodeActivityBlock);
}

export async function decodeTakeoutHtmlAsync(htmlText: string, onProgress?: (completed: number, total: number) => void): Promise<TakeoutActivityEvidence[]> {
    const blocks = activityBlocks(htmlText);
    const activities: TakeoutActivityEvidence[] = [];
    for (let index = 0; index < blocks.length; index++) {
        activities.push(decodeActivityBlock(blocks[index], index));
        if ((index + 1) % 50 === 0) {
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            if ((index + 1) % 100 === 0) onProgress?.(index + 1, blocks.length);
        }
    }
    onProgress?.(blocks.length, blocks.length);
    return activities;
}
