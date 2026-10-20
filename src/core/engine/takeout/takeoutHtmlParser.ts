import type { GeneratedMediaIdentity } from '../../../types/conversation.js';
import { findGenerationModelMessage } from '../generatedMediaIdentity.js';
import {
    normId as utilsNormId,
    shortScope as utilsShortScope,
    stripHtmlTags as utilsStripHtmlTags,
    sanitizeFileName
} from "../../utils/utils.js";
import type { GeminiUtilsModule } from "../../utils/utils.js";
import { TakeoutParseError } from "../../../types/errors.js";
import { __resolveModule } from "../../utils/moduleOverrides.js";
import { I18n as I18nStatic } from "../../utils/i18n.js";
import { ChatFormatter } from "../chatFormatter.js";
import type { Conversation } from "../../../types/index.js";

const getUtils = (): GeminiUtilsModule | null => __resolveModule('GeminiUtils', null);

export interface GenerationBlock {
    chatId: string;
    time: number;
    prompt: string;
    imageCount?: number;
    modelMessageIndex?: number;
    generation?: GeneratedMediaIdentity;
}

export interface ParseTakeoutHtmlOptions {
    htmlText: string;
    zipFiles: Record<string, any>;
    normIdFn?: (id?: string | null) => string;
    onProgress?: ((pct: number, msg: string) => void) | null;
}

export interface ParseTakeoutHtmlOutput {
    extractedMap: Record<string, Conversation>;
    localConvCache: Record<string, any>;
    localMediaMap: Record<string, any[]>;
    genBlocks: GenerationBlock[];
}

export interface TakeoutHtmlParserModule {
    stripHtmlTags: (html?: string | null | any) => string;
    unescapeHtmlEntities: (str: string) => string;
    parseTakeoutPrompt: (block: string) => { promptText: string; hasExplicitPrompt: boolean };
    parseTakeoutTimestamp: (block: string) => number | null;
    parseTakeoutHtmlBlocks: (options: ParseTakeoutHtmlOptions) => Promise<ParseTakeoutHtmlOutput>;
    correlateGeneratedImages: (
        watermarkedImages: any[],
        genBlocks: any[],
        localMediaMap: Record<string, any[]>,
        localConvCache: Record<string, any>,
        extractedMap: Record<string, any>
    ) => void;
}

export const stripHtmlTags = utilsStripHtmlTags;

/**
 * Safely unescapes basic HTML entities in a single pass to prevent double-unescaping vulnerabilities.
 */
export function unescapeHtmlEntities(str: string): string {
    if (!str || typeof str !== 'string') return '';
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

export function parseTakeoutPrompt(block: string): { promptText: string; hasExplicitPrompt: boolean } {
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
        let rawT = timeMatchEn[1].replace(/[\u202f\xa0]/g, ' ').trim();
        const { cleanText, offsetStr } = extractOffset(rawT);
        let dt = new Date(cleanText + offsetStr);
        if (!isNaN(dt.getTime())) ts = dt.getTime();
    } else if (timeMatchZh) {
        let rawZh = timeMatchZh[1].replace(/[\u202f\xa0]/g, ' ').trim();
        const { cleanText, offsetStr } = extractOffset(rawZh);
        let isPm = cleanText.includes('下午');
        let isAm = cleanText.includes('上午');
        let parts = cleanText.replace(/上午|下午/g, '').replace(/[A-Z]{2,4}/g, '').trim()
            .match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
        if (parts) {
            let y = parts[1], m = parts[2].padStart(2, '0'), d = parts[3].padStart(2, '0');
            let h = parseInt(parts[4], 10);
            let min = parts[5];
            let sec = parts[6] || '00';
            if (isPm && h < 12) h += 12;
            else if (isAm && h === 12) h = 0;
            let dateStr = `${y}-${m}-${d} ${String(h).padStart(2, '0')}:${min}:${sec}${offsetStr}`;
            let dt = new Date(dateStr);
            if (!isNaN(dt.getTime())) ts = dt.getTime();
        }
    } else if (timeMatchIso) {
        let dt = new Date(timeMatchIso[1].replace(/[\u202f\xa0]/g, ' '));
        if (!isNaN(dt.getTime())) ts = dt.getTime();
    }
    return ts;
}

export async function parseTakeoutHtmlBlocks(options: ParseTakeoutHtmlOptions): Promise<ParseTakeoutHtmlOutput> {
    const { htmlText, zipFiles, onProgress } = options;
    const normIdFn = options.normIdFn || ((id?: string | null) => {
        try {
            return ((getUtils()?.normId) || utilsNormId)(id);
        } catch {
            if (!id) return "";
            return String(id).replace(/^c_/, "").trim();
        }
    });

    const i18nInstance = __resolveModule('I18n', I18nStatic);
    const rawBlocks = htmlText.split('<div class="outer-cell');
    if (rawBlocks.length <= 1) {
        const hasOuterCell = htmlText.includes('outer-cell');
        const hasTakeoutMarker = /gemini|bard|MyActivity|我的活动/i.test(htmlText);
        if (!hasOuterCell && hasTakeoutMarker) {
            const err = i18nInstance.t('takeoutFormatChanged');
            throw new TakeoutParseError(err, true, 'MyActivity.html');
        }
    }

    const extractedMap: Record<string, Conversation> = {};
    const localConvCache: Record<string, any> = {};
    const localMediaMap: Record<string, any[]> = {};
    const genBlocks: GenerationBlock[] = [];

    for (let i = 1; i < rawBlocks.length; i++) {
        if (i % 50 === 0) {
            await new Promise(r => setTimeout(r, 0));
            if (onProgress && i % 100 === 0) {
                const pct = Math.min(88, 70 + Math.floor((i / rawBlocks.length) * 18));
                const msg = i18nInstance.t('takeoutParsingDetailProgress', i, rawBlocks.length - 1);
                onProgress(pct, msg);
            }
        }
        const block = rawBlocks[i];
        const linkMatches = Array.from(block.matchAll(/https:\/\/(?:gemini|bard)\.google\.com\/(?:u\/\d+\/)?(?:app|chat)\/([a-zA-Z0-9_-]{8,64})/g));
        if (!linkMatches.length) continue;

        const foundIds: string[] = [];
        for (const lm of linkMatches as RegExpMatchArray[]) {
            const cleanId = normIdFn(lm[1]);
            if (cleanId.length >= 8 && !foundIds.includes(cleanId)) {
                foundIds.push(cleanId);
            }
        }
        if (!foundIds.length) continue;

        const { promptText, hasExplicitPrompt } = parseTakeoutPrompt(block);
        const ts = parseTakeoutTimestamp(block);

        const genMatch = /(?:(\d+)\s*generated images?|(\d+)\s*张生成的图片)/i.exec(block);
        const hasGenMarker = !!genMatch;
        const blockGenerations: GenerationBlock[] = [];
        if (hasGenMarker && foundIds.length > 0 && ts) {
            for (const cid of foundIds) {
                const generationBlock: GenerationBlock = {
                    chatId: cid, time: ts, prompt: promptText,
                    imageCount: Number(genMatch![1] || genMatch![2]),
                };
                genBlocks.push(generationBlock);
                blockGenerations.push(generationBlock);
            }
        }

        const contentCellMatch = block.match(/<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">([\s\S]*?)<\/div>/i);
        let responseHtml = '';
        if (contentCellMatch) {
            const rawCc = contentCellMatch[1];
            const parts = rawCc.split(/<br\s*\/?>|\n/);
            const respParts: string[] = [];
            let started = false;
            for (const p of parts) {
                if (started) {
                    respParts.push(p);
                } else if (/<p>|<pre>|<table>|<h1>|<h2>|<h3>|<ul>|<ol>|<strong>|<em>|<code>/i.test(p)) {
                    started = true;
                    respParts.push(p);
                }
            }
            responseHtml = respParts.join('\n').trim();
        }

        const rawMediaMatches = block.match(/(?:src|href)=["']([^#"'>]+?)["']/gi) || [];
        const localMediaNames: string[] = [];
        for (const raw of rawMediaMatches) {
            const val = raw.replace(/^(?:src|href)=["']/, '').replace(/["']$/, '').trim();
            if (/^(?:https?:|\/\/|javascript:|mailto:|data:)/i.test(val) || /\.html?$/i.test(val)) continue;
            try {
                const decoded = decodeURIComponent(val).replace(/^.*[\\\/]/, '').trim();
                if (decoded && !localMediaNames.includes(decoded)) {
                    localMediaNames.push(decoded);
                }
            } catch {
                const simpleName = val.replace(/^.*[\\\/]/, '').trim();
                if (simpleName && !localMediaNames.includes(simpleName)) {
                    localMediaNames.push(simpleName);
                }
            }
        }

        const turnMsgs: any[] = [];
        if (promptText) {
            const userMsg: any = {
                role: 'user',
                content: promptText,
                timestamp: ts ?? null
            };
            if (localMediaNames.length > 0) {
                userMsg.images = localMediaNames.map(name => ({
                    url: name,
                    name: name,
                    fileName: name,
                    localName: `assets/${sanitizeFileName(name, 'img.jpg')}`,
                    source: 'takeout'
                }));
                userMsg.attachments = localMediaNames.map(name => ({
                    type: /\.(jpe?g|png|gif|webp|bmp|svg)$/i.test(name) ? 'image' : 'file',
                    url: name,
                    name: name,
                    fileName: name,
                    localName: `assets/${sanitizeFileName(name, 'attachment')}`,
                    source: 'takeout'
                }));
            }
            turnMsgs.push(userMsg);
        }
        if (responseHtml || hasGenMarker) {
            const modelTurn: any = {
                role: 'model',
                content: responseHtml,
                timestamp: (ts ? ts + 2000 : null)
            };

            const isHtmlReport = /<h1[^>]*>/i.test(responseHtml) && responseHtml.length > 3000;
            if (isHtmlReport) {
                const h1Match = responseHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
                let docTitle = 'Deep Research Report';
                if (h1Match) {
                    docTitle = unescapeHtmlEntities(stripHtmlTags(h1Match[1])).trim();
                }
                const convHtml = ChatFormatter.convertHtmlToMarkdown;
                let docMd = convHtml ? convHtml(responseHtml) : responseHtml.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m: string, lvl: string, txt: string) => `\n${'#'.repeat(parseInt(lvl, 10))} ${txt.trim()}\n`);
                if (!docMd.trim().startsWith('#')) {
                    docMd = `# ${docTitle}\n\n${docMd.trim()}`;
                }
                const primaryCleanId = foundIds[0] || 'takeout';
                const shortScope = utilsShortScope(primaryCleanId);
                const safeDocTitle = sanitizeFileName(docTitle, 'doc').slice(0, 60);
                const localName = `files/${shortScope}${safeDocTitle}.md`;

                const docObj = {
                    type: 'file',
                    id: `${primaryCleanId}_doc_${Date.now()}`,
                    title: docTitle,
                    name: `${safeDocTitle}.md`,
                    localName,
                    contentMarkdown: docMd,
                    source: 'takeout-report'
                };
                modelTurn.documents = [docObj];
                modelTurn.attachments = [docObj];
            }

            turnMsgs.push(modelTurn);
        }

        const __zipEntries: { filename: string; stem: string; fObj: any }[] = [];
        const __zipExact = new Map<string, { filename: string; stem: string; fObj: any }[]>();
        for (const [path, fObj] of Object.entries<any>(zipFiles)) {
            if ((fObj as any).dir) continue;
            const zipFilename = path.replace(/^.*[\\\/]/, '').trim();
            const entry = {
                filename: zipFilename,
                stem: zipFilename.replace(/\.[^/.]+$/, '').toLowerCase(),
                fObj
            };
            __zipEntries.push(entry);
            for (const key of [zipFilename.toLowerCase(), entry.stem]) {
                let arr = __zipExact.get(key);
                if (!arr) { arr = []; __zipExact.set(key, arr); }
                arr.push(entry);
            }
        }

        for (const cleanId of foundIds) {
            if (!localMediaMap[cleanId]) localMediaMap[cleanId] = [];
            for (const refName of localMediaNames) {
                const refStem = refName.replace(/\.[^/.]+$/, '').toLowerCase();
                const refLower = refName.toLowerCase();
                const consider = (entry: { filename: string; stem: string; fObj: any }): void => {
                    if (entry.filename === refName || entry.stem === refStem ||
                        entry.filename.endsWith(refName) ||
                        (refStem.length > 5 && entry.stem.includes(refStem))) {
                        if (!localMediaMap[cleanId].some(x => x.filename === entry.filename)) {
                            localMediaMap[cleanId].push({ filename: entry.filename, fileObj: entry.fObj });
                        }
                    }
                };
                const seenExact = new Set<string>();
                for (const key of [refLower, refStem]) {
                    const arr = __zipExact.get(key);
                    if (arr) for (const e of arr) {
                        if (!seenExact.has(e.filename)) { seenExact.add(e.filename); consider(e); }
                    }
                }
                for (const e of __zipEntries) {
                    if (seenExact.has(e.filename)) continue;
                    consider(e);
                }
            }

            const generationBlock = blockGenerations.find((gb) => gb.chatId === cleanId);
            if (generationBlock) {
                generationBlock.modelMessageIndex = (localConvCache[cleanId]?.messages?.length || 0)
                    + turnMsgs.findIndex((m) => m.role === 'model');
            }

            const promptTitle = promptText ? promptText.split('\n')[0].slice(0, 80).trim() : 'Takeout conversation';
            if (!localConvCache[cleanId]) {
                localConvCache[cleanId] = {
                    id: cleanId,
                    title: promptTitle,
                    titleSource: 'takeout',
                    titles: { takeout: promptTitle },
                    messages: turnMsgs.map((m) => ({ ...m })),
                    timestamp: ts,
                    messageCount: turnMsgs.length,
                    attachmentCount: localMediaNames.length,
                    source: 'takeout-offline',
                    hasExplicitPrompt
                };
            } else if (turnMsgs.length > 0) {
                localConvCache[cleanId].messages.push(...turnMsgs.map((m) => ({ ...m })));
                localConvCache[cleanId].messageCount = localConvCache[cleanId].messages.length;
                localConvCache[cleanId].attachmentCount = (localConvCache[cleanId].attachmentCount || 0) + localMediaNames.length;
                if (hasExplicitPrompt && !localConvCache[cleanId].hasExplicitPrompt && promptTitle) {
                    localConvCache[cleanId].title = promptTitle;
                    localConvCache[cleanId].titles = localConvCache[cleanId].titles || {};
                    localConvCache[cleanId].titles.takeout = promptTitle;
                    localConvCache[cleanId].hasExplicitPrompt = true;
                }
            }

            if (!extractedMap[cleanId]) {
                extractedMap[cleanId] = {
                    id: cleanId,
                    title: promptTitle,
                    titleSource: 'takeout',
                    titles: { takeout: promptTitle },
                    url: `https://gemini.google.com/app/${cleanId}`,
                    href: `https://gemini.google.com/app/${cleanId}`,
                    // Missing timestamp stays null so merge does not overwrite authoritative data
                    timestamp: ts ?? null,
                    lastSeen: ts ? new Date(ts).toISOString() : '',
                    source: 'takeout-import',
                    messageCount: turnMsgs.length,
                    attachmentCount: localMediaNames.length,
                    hasExplicitPrompt
                };
            } else {
                extractedMap[cleanId].attachmentCount = (extractedMap[cleanId].attachmentCount || 0) + localMediaNames.length;
                const cleanPrompt = promptText ? promptText.split('\n')[0].slice(0, 80).trim() : '';
                const shouldUpdate = cleanPrompt && (
                    (hasExplicitPrompt && !extractedMap[cleanId].hasExplicitPrompt) ||
                    !extractedMap[cleanId].title ||
                    extractedMap[cleanId].title.startsWith('Untitled') ||
                    extractedMap[cleanId].title === 'Takeout conversation'
                );
                if (shouldUpdate) {
                    extractedMap[cleanId].title = cleanPrompt;
                    extractedMap[cleanId].titles = extractedMap[cleanId].titles || {};
                    extractedMap[cleanId].titles.takeout = cleanPrompt;
                    if (hasExplicitPrompt) extractedMap[cleanId].hasExplicitPrompt = true;
                    if (localConvCache[cleanId]) {
                        localConvCache[cleanId].title = cleanPrompt;
                        localConvCache[cleanId].titles = localConvCache[cleanId].titles || {};
                        localConvCache[cleanId].titles.takeout = cleanPrompt;
                        if (hasExplicitPrompt) localConvCache[cleanId].hasExplicitPrompt = true;
                    }
                }
                if (ts && (!extractedMap[cleanId].timestamp || ts > extractedMap[cleanId].timestamp)) {
                    extractedMap[cleanId].timestamp = ts;
                    extractedMap[cleanId].lastSeen = new Date(ts).toISOString();
                }
            }
        }
    }

    const eventCounts = new Map<string, number>();
    for (const block of [...genBlocks].sort((a, b) => a.time - b.time)) {
        const ordinal = eventCounts.get(block.chatId) || 0;
        eventCounts.set(block.chatId, ordinal + 1);
        block.generation = {
            chatId: block.chatId, time: block.time, prompt: block.prompt,
            generationOrdinal: ordinal, imageCount: block.imageCount,
        };
        const model = localConvCache[block.chatId]?.messages?.[block.modelMessageIndex!];
        if (model?.role === 'model') model.generation = block.generation;
    }

    return {
        extractedMap,
        localConvCache,
        localMediaMap,
        genBlocks
    };
}

export function correlateGeneratedImages(
    watermarkedImages: any[],
    genBlocks: any[],
    localMediaMap: Record<string, any[]>,
    localConvCache: Record<string, any>,
    extractedMap: Record<string, any>
): void {
    const blockOrdinalMap = new Map<any, number>();

    function linkTakeoutGeneratedImage(block: GenerationBlock, img: any, imageOrdinal = 0): void {
        const chatId = block.chatId;
        const providerRequestId = img.providerRequestId || block.generation?.providerRequestId;
        const totalCount = block.imageCount || 1;
        const generation: GeneratedMediaIdentity = {
            ...(block.generation || { chatId, time: block.time, prompt: block.prompt, generationOrdinal: 0, imageCount: block.imageCount }),
            providerRequestId,
            imageCount: totalCount,
            imageOrdinal,
        };
        if (!localMediaMap[chatId]) localMediaMap[chatId] = [];
        const existing = localMediaMap[chatId].find(x => x.filename === img.filename);
        if (existing) {
            existing.isGenerated = true;
            existing.providerRequestId = providerRequestId;
            existing.imageOrdinal = imageOrdinal;
            existing.generation = generation;
        } else {
            localMediaMap[chatId].push({
                filename: img.filename, fileObj: img.fileObj, isGenerated: true,
                providerRequestId, imageOrdinal, generation,
            });
        }
        const imgObj = {
            url: img.filename,
            name: img.filename,
            fileName: img.filename,
            localName: `assets/${img.filename}`,
            source: 'takeout',
            isGenerated: true,
            providerRequestId,
            imageOrdinal,
            generation
        };
        const cached = localConvCache[chatId];
        if (cached && Array.isArray(cached.messages)) {
            let modelTurn = findGenerationModelMessage(cached, generation);
            if (!modelTurn) {
                modelTurn = {
                    role: 'model',
                    generation,
                    providerRequestId,
                    content: `![Generated Image](assets/${img.filename})`,
                    timestamp: img.time || (cached.timestamp ? cached.timestamp + 2000 : null),
                    images: [imgObj],
                    attachments: [imgObj]
                };
                cached.messages.push(modelTurn);
            } else {
                modelTurn.images = modelTurn.images || [];
                modelTurn.attachments = modelTurn.attachments || [];
                if (!modelTurn.providerRequestId && providerRequestId) {
                    modelTurn.providerRequestId = providerRequestId;
                }
                if (!modelTurn.images.some((im: any) => im.fileName === img.filename)) {
                    modelTurn.images.push(imgObj);
                }
                if (!modelTurn.attachments.some((at: any) => at.fileName === img.filename)) {
                    modelTurn.attachments.push(imgObj);
                }
                if (!modelTurn.content.includes(img.filename)) {
                    modelTurn.content = (modelTurn.content ? modelTurn.content + '\n\n' : '') + `![Generated Image](assets/${img.filename})`;
                }
            }
            cached.attachmentCount = (cached.attachmentCount || 0) + 1;
        }
        if (extractedMap[chatId]) {
            extractedMap[chatId].attachmentCount = (extractedMap[chatId].attachmentCount || 0) + 1;
        }
    }

    if (watermarkedImages.length === 1 && genBlocks.length === 1) {
        linkTakeoutGeneratedImage(genBlocks[0], watermarkedImages[0], 0);
    } else {
        for (const img of watermarkedImages) {
            let bestBlock: any = null;
            let minDiff = Infinity;
            for (const gb of genBlocks) {
                if (!gb.time || !img.time) continue;
                const diff = img.time - gb.time;
                if (diff >= -5000 && diff <= 120000 && diff < minDiff) {
                    minDiff = diff;
                    bestBlock = gb;
                }
            }
            if (bestBlock) {
                const ord = blockOrdinalMap.get(bestBlock) || 0;
                blockOrdinalMap.set(bestBlock, ord + 1);
                linkTakeoutGeneratedImage(bestBlock, img, ord);
            }
        }
    }
}

export const TakeoutHtmlParser: TakeoutHtmlParserModule = {
    stripHtmlTags,
    unescapeHtmlEntities,
    parseTakeoutPrompt,
    parseTakeoutTimestamp,
    parseTakeoutHtmlBlocks,
    correlateGeneratedImages
};

export default TakeoutHtmlParser;
