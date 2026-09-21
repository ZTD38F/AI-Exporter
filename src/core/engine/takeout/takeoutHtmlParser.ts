/**
 * src/core/engine/takeout/takeoutHtmlParser.ts
 * Dedicated HTML parser for Google Takeout (MyActivity.html / 我的活动.html).
 * Handles turn extraction, markdown conversion, timestamp normalization,
 * document detection, and generated image correlation.
 */

import { normId as utilsNormId } from "../../utils/utils.js";
import { TakeoutParseError } from "../../../types/errors.js";
import type { Conversation } from "../../../types/index.js";

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
    genBlocks: Array<{ chatId: string; time: number; prompt: string }>;
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

declare global {
    var TakeoutHtmlParser: TakeoutHtmlParserModule;
    var I18n: any;
}

/**
 * Strips HTML tags recursively to ensure safe plain text output.
 */
export function stripHtmlTags(html?: string | null | any): string {
    if (!html || typeof html !== 'string') return '';
    let prev: string;
    do {
        prev = html;
        html = html.replace(/<[^>]+>/g, '');
    } while (html !== prev);
    return html;
}

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

/**
 * Extracts prompt text and whether an explicit Prompted prefix was found in the HTML block.
 */
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

/**
 * Normalizes multi-locale datetime strings into Unix timestamps (milliseconds).
 */
export function parseTakeoutTimestamp(block: string): number | null {
    let ts: number | null = null;
    const timeMatchEn = block.match(/([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4},\s+\d{1,2}:\d{2}(?::\d{2})?\s*[\u202f\s]*(?:AM|PM)\s*[A-Z]*)/);
    const timeMatchZh = block.match(/(\d{4}年\d{1,2}月\d{1,2}日[\s\u202f\xa0]*(?:上午|下午)?\s*\d{1,2}:\d{2}(?::\d{2})?)/);
    const timeMatchIso = block.match(/(\d{4}[-/]\d{1,2}[-/]\d{1,2}[\sT]\d{1,2}:\d{2}(?::\d{2})?)/);

    if (timeMatchEn) {
        let rawT = timeMatchEn[1].replace(/[\u202f\xa0]/g, ' ').trim();
        const tzMap: Record<string, string> = {
            'UTC': '+0000', 'GMT': '+0000',
            'EDT': '-0400', 'EST': '-0500',
            'CDT': '-0500', 'CST': '-0600',
            'MDT': '-0600', 'MST': '-0700',
            'PDT': '-0700', 'PST': '-0800',
            'AKDT': '-0800', 'AKST': '-0900',
            'HST': '-1000', 'HDT': '-0900',
            'BST': '+0100', 'CET': '+0100', 'CEST': '+0200',
            'EET': '+0200', 'EEST': '+0300',
            'IST': '+0530', 'JST': '+0900',
            'AEST': '+1000', 'AEDT': '+1100'
        };
        const tzMatch = rawT.match(/\s+([A-Z]{3,4})$/);
        let tzOffsetStr = '';
        if (tzMatch && tzMap[tzMatch[1]]) {
            tzOffsetStr = ' GMT' + tzMap[tzMatch[1]];
        }
        let cleanT = rawT.replace(/\s+[A-Z]{3,4}$/, '').trim() + tzOffsetStr;
        let dt = new Date(cleanT);
        if (!isNaN(dt.getTime())) ts = dt.getTime();
    } else if (timeMatchZh) {
        let rawZh = timeMatchZh[1];
        let isPm = rawZh.includes('下午');
        let isAm = rawZh.includes('上午');
        let cleanZh = rawZh.replace(/上午|下午/g, '').replace(/[年月日]/g, (m: string) => m === '年' || m === '月' ? '-' : ' ')
                           .replace(/[\u202f\xa0]/g, ' ').replace(/\s+/g, ' ').trim();
        let dt = new Date(cleanZh);
        if (!isNaN(dt.getTime())) {
            let h = dt.getHours();
            if (isPm && h < 12) dt.setHours(h + 12);
            else if (isAm && h === 12) dt.setHours(0);
            ts = dt.getTime();
        }
    } else if (timeMatchIso) {
        let dt = new Date(timeMatchIso[1].replace(/[\u202f\xa0]/g, ' '));
        if (!isNaN(dt.getTime())) ts = dt.getTime();
    }
    return ts;
}

/**
 * Parses all outer-cell conversation blocks from Takeout HTML.
 */
export async function parseTakeoutHtmlBlocks(options: ParseTakeoutHtmlOptions): Promise<ParseTakeoutHtmlOutput> {
    const { htmlText, zipFiles, onProgress } = options;
    const normIdFn = options.normIdFn || ((id?: string | null) => {
        try {
            if (typeof globalThis !== "undefined" && (globalThis as any).GeminiUtils?.normId) {
                return (globalThis as any).GeminiUtils.normId(id);
            }
            return utilsNormId(id);
        } catch {
            if (!id) return "";
            return String(id).replace(/^c_/, "").trim();
        }
    });

    const rawBlocks = htmlText.split('<div class="outer-cell');
    if (rawBlocks.length <= 1) {
        const hasOuterCell = htmlText.includes('outer-cell');
        const hasTakeoutMarker = /gemini|bard|MyActivity|我的活动/i.test(htmlText);
        if (!hasOuterCell && hasTakeoutMarker) {
            const i18nInstance = typeof I18n !== 'undefined' ? I18n : (globalThis as any).I18n;
            const err = i18nInstance && typeof i18nInstance.t === 'function'
                ? i18nInstance.t('takeoutFormatChanged')
                : 'Takeout 归档格式未能识别，可能 Google 已调整导出结构';
            throw new TakeoutParseError(err, true, 'MyActivity.html');
        }
    }

    const extractedMap: Record<string, Conversation> = {};
    const localConvCache: Record<string, any> = {};
    const localMediaMap: Record<string, any[]> = {};
    const genBlocks: Array<{ chatId: string; time: number; prompt: string }> = [];

    for (let i = 1; i < rawBlocks.length; i++) {
        if (i % 50 === 0) {
            await new Promise(r => setTimeout(r, 0));
            if (onProgress && i % 100 === 0) {
                const pct = Math.min(88, 70 + Math.floor((i / rawBlocks.length) * 18));
                const i18nInstance = typeof I18n !== 'undefined' ? I18n : (globalThis as any).I18n;
                const msg = i18nInstance && typeof i18nInstance.t === 'function'
                    ? i18nInstance.t('takeoutParsingDetailProgress', i, rawBlocks.length - 1)
                    : `正在解析对话并建立离线媒体索引 (${i}/${rawBlocks.length - 1})...`;
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

        const hasGenMarker = /(?:(\d+)\s*generated images?|(\d+)\s*张生成的图片)/i.test(block);
        if (hasGenMarker && foundIds.length > 0 && ts) {
            for (const cid of foundIds) {
                genBlocks.push({
                    chatId: cid,
                    time: ts,
                    prompt: promptText
                });
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
                timestamp: ts || Date.now()
            };
            if (localMediaNames.length > 0) {
                userMsg.images = localMediaNames.map(name => ({
                    url: name,
                    name: name,
                    fileName: name,
                    localName: `assets/${name.replace(/[\\/:*?"<>|]/g, '_')}`,
                    source: 'takeout'
                }));
                userMsg.attachments = localMediaNames.map(name => ({
                    type: /\.(jpe?g|png|gif|webp|bmp|svg)$/i.test(name) ? 'image' : 'file',
                    url: name,
                    name: name,
                    fileName: name,
                    localName: `assets/${name.replace(/[\\/:*?"<>|]/g, '_')}`,
                    source: 'takeout'
                }));
            }
            turnMsgs.push(userMsg);
        }
        if (responseHtml) {
            const modelTurn: any = {
                role: 'model',
                content: responseHtml,
                timestamp: (ts ? ts + 2000 : Date.now())
            };

            const isHtmlReport = /<h1[^>]*>/i.test(responseHtml) && responseHtml.length > 3000;
            if (isHtmlReport) {
                const h1Match = responseHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
                let docTitle = 'Deep Research Report';
                if (h1Match) {
                    docTitle = unescapeHtmlEntities(stripHtmlTags(h1Match[1])).trim();
                }
                const convHtml = (globalThis as any).ChatFormatter?.convertHtmlToMarkdown;
                let docMd = convHtml ? convHtml(responseHtml) : responseHtml.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m: string, lvl: string, txt: string) => `\n${'#'.repeat(parseInt(lvl, 10))} ${txt.trim()}\n`);
                if (!docMd.trim().startsWith('#')) {
                    docMd = `# ${docTitle}\n\n${docMd.trim()}`;
                }
                const primaryCleanId = foundIds[0] || 'takeout';
                const shortScope = primaryCleanId.length >= 6 ? `${primaryCleanId.slice(-6)}_` : '';
                const safeDocTitle = docTitle.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
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

        for (const cleanId of foundIds) {
            if (!localMediaMap[cleanId]) localMediaMap[cleanId] = [];
            for (const refName of localMediaNames) {
                const refStem = refName.replace(/\.[^/.]+$/, '').toLowerCase();
                for (const [path, fObj] of Object.entries<any>(zipFiles)) {
                    if (fObj.dir) continue;
                    const zipFilename = path.replace(/^.*[\\\/]/, '').trim();
                    const zipStem = zipFilename.replace(/\.[^/.]+$/, '').toLowerCase();
                    if (zipFilename === refName || zipStem === refStem || zipFilename.endsWith(refName) || (refStem.length > 5 && zipStem.includes(refStem))) {
                        if (!localMediaMap[cleanId].some(x => x.filename === zipFilename)) {
                            localMediaMap[cleanId].push({ filename: zipFilename, fileObj: fObj });
                        }
                    }
                }
            }

            const promptTitle = promptText ? promptText.split('\n')[0].slice(0, 80).trim() : 'Takeout conversation';
            if (!localConvCache[cleanId]) {
                localConvCache[cleanId] = {
                    id: cleanId,
                    title: promptTitle,
                    titleSource: 'takeout',
                    titles: { takeout: promptTitle },
                    messages: [...turnMsgs],
                    timestamp: ts,
                    messageCount: turnMsgs.length,
                    attachmentCount: localMediaNames.length,
                    source: 'takeout-offline',
                    hasExplicitPrompt
                };
            } else if (turnMsgs.length > 0) {
                localConvCache[cleanId].messages.push(...turnMsgs);
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
                    timestamp: ts || Date.now(),
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

    return {
        extractedMap,
        localConvCache,
        localMediaMap,
        genBlocks
    };
}

/**
 * Correlates watermarked AI-generated images with conversation turns based on timestamp proximity.
 */
export function correlateGeneratedImages(
    watermarkedImages: any[],
    genBlocks: any[],
    localMediaMap: Record<string, any[]>,
    localConvCache: Record<string, any>,
    extractedMap: Record<string, any>
): void {
    if (watermarkedImages.length === 0 || genBlocks.length === 0) return;

    function linkTakeoutGeneratedImage(chatId: string, img: any): void {
        if (!localMediaMap[chatId]) localMediaMap[chatId] = [];
        if (!localMediaMap[chatId].some(x => x.filename === img.filename)) {
            localMediaMap[chatId].push({
                filename: img.filename,
                fileObj: img.fileObj,
                isGenerated: true
            });
        }
        const imgObj = {
            url: img.filename,
            name: img.filename,
            fileName: img.filename,
            localName: `assets/${img.filename}`,
            source: 'takeout',
            isGenerated: true
        };
        const cached = localConvCache[chatId];
        if (cached && Array.isArray(cached.messages)) {
            let modelTurn = cached.messages.find((m: any) => m.role === 'model');
            if (!modelTurn) {
                modelTurn = {
                    role: 'model',
                    content: `![Generated Image](assets/${img.filename})`,
                    timestamp: img.time || (cached.timestamp ? cached.timestamp + 2000 : Date.now()),
                    images: [imgObj],
                    attachments: [imgObj]
                };
                cached.messages.push(modelTurn);
            } else {
                modelTurn.images = modelTurn.images || [];
                modelTurn.attachments = modelTurn.attachments || [];
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
        linkTakeoutGeneratedImage(genBlocks[0].chatId, watermarkedImages[0]);
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
                linkTakeoutGeneratedImage(bestBlock.chatId, img);
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

if (typeof globalThis !== 'undefined' && !(globalThis as any).TakeoutHtmlParser) {
    (globalThis as any).TakeoutHtmlParser = TakeoutHtmlParser;
}
if (typeof module === 'object' && module.exports) {
    module.exports = TakeoutHtmlParser;
}
export default TakeoutHtmlParser;
