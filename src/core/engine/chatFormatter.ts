/**
 * chatFormatter.ts
 * Unified export formatter for Gemini conversations.
 * Supports Markdown (Obsidian / Notion / Logseq optimized), OpenAI JSON, Standard JSON, and Raw JSON.
 */
import type { Conversation, ChatMessage, Attachment } from "../../types/conversation.js";

export interface FormattedResult {
    content: string;
    ext: string;
    mime: string;
}

export interface ChatFormatterOptions {
    lang?: string;
    [key: string]: any;
}

export interface ChatFormatterModule {
    adjustHeadingHierarchy: (text: string, shift?: number) => string;
    renderAttachments: (atts?: Attachment[] | null, isEn?: boolean) => string;
    convertHtmlToMarkdown: (html?: string | null) => string;
    cleanMessageBody: (text?: string | null) => string;
    toMarkdown: (chat: any, opts?: ChatFormatterOptions) => string;
    toOpenAIJson: (chat: any) => string;
    formatContent: (chat: any, formatType?: string, opts?: ChatFormatterOptions) => FormattedResult;
}

declare global {
    var ChatFormatter: ChatFormatterModule;
}


    /**
     * Intelligently shift Markdown heading levels (e.g. # -> ###, ## -> ####)
     * while protecting code fences (``` or ~~~) from being modified.
     */
    function adjustHeadingHierarchy(text: string, shift: number = 2): string {
        if (!text || typeof text !== 'string') return text || '';
        const lines = text.split('\n');
        const out: string[] = [];
        let inCodeBlock = false;
        let fenceChar = '';
        let fenceLen = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const stripped = line.trim();

            if (!inCodeBlock) {
                if (stripped.startsWith('```') || stripped.startsWith('~~~')) {
                    inCodeBlock = true;
                    fenceChar = stripped[0];
                    fenceLen = stripped.length - stripped.replace(new RegExp(`^\\${fenceChar}+`), '').length;
                    out.push(line);
                    continue;
                }
            } else {
                if (stripped.startsWith(fenceChar.repeat(fenceLen))) {
                    inCodeBlock = false;
                }
                out.push(line);
                continue;
            }

            // Outside code block: check if line starts with markdown heading (# )
            if (line.startsWith('#')) {
                const match = line.match(/^(#{1,6})(\s+.*)$/);
                if (match) {
                    const currentLevel = match[1].length;
                    const newLevel = Math.min(6, currentLevel + shift);
                    out.push('#'.repeat(newLevel) + match[2]);
                    continue;
                }
            }

            out.push(line);
        }

        return out.join('\n');
    }

    /**
     * Render message attachments in Markdown format.
     */
    function renderAttachments(atts?: any[] | null, isEn: boolean = false): string {
        if (!atts || !Array.isArray(atts) || !atts.length) return '';
        let block = '';
        for (const att of atts) {
            if (att.type === 'image') {
                const local = att.localName || `assets/image.jpg`;
                const alt = String(att.alt || att.name || (isEn ? 'Image' : '图片')).replace(/[[\]]/g, '');
                const online = att.src || att.originalUrl || '';
                if (online && online.startsWith('http') && !online.includes('googleusercontent.com/immersive_entry_chip')) {
                    block += `[![${alt}](${local})](${online})\n\n`;
                } else {
                    block += `![${alt}](${local})\n\n`;
                }
            } else if (att.type === 'file') {
                const local = att.localName || `files/${att.name || 'attachment'}`;
                let name = att.title || att.name || (isEn ? 'Attachment' : '附件');
                if (/^(我已经完成了研究|我拟定了一个研究方案|I've completed your research|Here is a research plan)/i.test(name)) {
                    name = isEn ? '📑 Deep Research Report' : '📑 深度研究报告 (Deep Research Report)';
                }
                block += `- 📎 [${name}](${local})\n\n`;
            }
        }
        return block;
    }

    /**
     * Convert HTML content (from Google Takeout or HTML-rich model responses) to Markdown.
     */
    function convertHtmlToMarkdown(html?: string | null): string {
        if (!html || typeof html !== 'string') return html || '';
        if (!/<(?:pre|code|p|h[1-6]|ul|ol|li|blockquote|strong|b|em|i)[\s>]/i.test(html)) return html;

        let res = html;
        // 1. Convert <pre><code> blocks
        res = res.replace(/<pre><code(?:\s+class=["'](?:language-)?([a-z0-9_-]+)["'])?>([\s\S]*?)<\/code><\/pre>/gi, (_match, lang, code) => {
            let cleanCode = code
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&amp;/g, '&');
            return `\n\`\`\`${lang || ''}\n${cleanCode.trim()}\n\`\`\`\n`;
        });
        // 2. Inline code
        res = res.replace(/<code>([\s\S]*?)<\/code>/gi, (_match, code) => {
            let cleanCode = code
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&amp;/g, '&');
            return `\`${cleanCode}\``;
        });
        // 3. Headings
        res = res.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl, txt) => `\n${'#'.repeat(parseInt(lvl, 10))} ${txt.trim()}\n`);
        // 4. Paragraphs and breaks
        res = res.replace(/<br\s*\/?>/gi, '\n');
        res = res.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n');
        // 5. Bold & italic
        res = res.replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, '**$1**');
        res = res.replace(/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, '*$1*');
        // 6. Strip any other HTML tags repeatedly to remove nested tags
        let prev = '';
        do {
            prev = res;
            res = res.replace(/<[^>]+>/g, '');
        } while (res !== prev);
        return res;
    }

    /**
     * Sanitize message body content from Google internal placeholder URLs and tool anchors
     */
    function cleanMessageBody(text?: string | null): string {
        if (!text || typeof text !== 'string') return '';
        let converted = convertHtmlToMarkdown(text);
        // 1. Remove standalone tool/chip placeholder URL lines
        let cleaned = converted.replace(/(?:^|\n)\s*(?:\[)?https?:\/\/googleusercontent\.com\/(?:immersive_entry_chip|deep_research_confirmation_content|map_content|map_location_reference|grounding_content|web_search_content|youtube_content|flights_content|hotels_content|workspace_content|image_generation_content|imagegenerationcontent|generated_image)(?:\/[^\s\n\]]*)?(?:\])?\s*(?=\n|$)/gi, '\n');
        // 2. Unwrap Markdown links pointing to internal placeholders: [Text](https://googleusercontent.com/...) -> Text
        cleaned = cleaned.replace(/\[([^\]]+)\]\(https?:\/\/googleusercontent\.com\/(?:immersive_entry_chip|deep_research_confirmation_content|map_content|map_location_reference|grounding_content|web_search_content|youtube_content|flights_content|hotels_content|workspace_content|image_generation_content|imagegenerationcontent|generated_image)[^\)]*\)/gi, '$1');
        // 3. Remove any remaining inline pseudo URLs
        cleaned = cleaned.replace(/https?:\/\/googleusercontent\.com\/(?:immersive_entry_chip|deep_research_confirmation_content|map_content|map_location_reference|grounding_content|web_search_content|youtube_content|flights_content|hotels_content|workspace_content|image_generation_content|imagegenerationcontent|generated_image)(?:\/[^\s\n\)]*)?/gi, '');
        return cleaned.trim();
    }

    /**
     * Intelligently detect and encapsulate unfenced raw code in user messages.
     */
    function sanitizeUserPrompt(text?: string | null): string {
        if (!text || typeof text !== 'string') return '';
        let cleaned = cleanMessageBody(text);
        if (!cleaned) return '';

        // If message has raw userscript or ultra-long code without markdown code fence
        if (!cleaned.includes('```') && (cleaned.includes('// ==UserScript==') || cleaned.length > 400)) {
            const lines = cleaned.split('\n');
            let outLines: string[] = [];
            let inFence = false;
            for (let line of lines) {
                let s = line.trim();
                if (s.startsWith('// ==UserScript==') && !inFence) {
                    outLines.push('```javascript');
                    outLines.push(line);
                    inFence = true;
                } else if (s.length > 400 && !inFence && (s.includes('function(') || s.includes('var ') || s.includes('const ') || s.includes('\\x'))) {
                    outLines.push('```javascript');
                    outLines.push(line);
                    outLines.push('```');
                } else {
                    outLines.push(line);
                }
            }
            if (inFence) outLines.push('```');
            return outLines.join('\n');
        }
        return cleaned;
    }

    /**
     * Convert conversation object to standardized Markdown.
     * Compatible with Obsidian, Notion, Logseq, Typora, and GitHub Markdown.
     */
    function toMarkdown(chat: any, opts: ChatFormatterOptions = {}): string {
        if (!chat) return '';
        const isEn = (opts.lang === 'en') || (typeof (globalThis as any).I18n !== 'undefined' && (globalThis as any).I18n.getLang && (globalThis as any).I18n.getLang() === 'en');

        if (chat.error) {
            const failTitle = isEn ? 'Export Failed' : '导出失败';
            return `# ${chat.title || 'Untitled'}\n\n> ${failTitle}: ${chat.error}\n\n> ID: ${chat.id} | URL: ${chat.url || ''}\n`;
        }

        const safeTitleClean = String(chat.title || 'Untitled').replace(/[\r\n]+/g, ' ').trim();
        const safeYamlTitle = safeTitleClean.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const createdIso = (chat.createdAt || chat.timestamp || chat.updatedAt) ? new Date(chat.createdAt || chat.timestamp || chat.updatedAt).toISOString() : new Date().toISOString();
        const updatedIso = (chat.updatedAt || chat.timestamp || chat.createdAt) ? new Date(chat.updatedAt || chat.timestamp || chat.createdAt).toISOString() : createdIso;
        const convUrl = chat.url || (chat.id ? `https://gemini.google.com/app/${String(chat.id).replace(/^c_/, '')}` : '');

        // 1. YAML Frontmatter (Obsidian Properties / Notion Database / Logseq)
        let md = `---\n`;
        md += `title: "${safeYamlTitle}"\n`;
        md += `id: "${chat.id || ''}"\n`;
        if (convUrl) md += `url: "${convUrl}"\n`;
        if (createdIso) md += `date: "${createdIso}"\n`;
        if (updatedIso) md += `updated: "${updatedIso}"\n`;
        md += `exported: "${new Date().toISOString()}"\n`;
        md += `tags:\n  - gemini-export\n`;
        md += `---\n\n`;

        // 2. Document Title & Metadata Badges
        md += `# ${safeTitleClean}\n\n`;
        const metaBadges: string[] = [];
        const linkText = isEn ? '🔗 Chat Link' : '🔗 对话链接';
        if (convUrl) metaBadges.push(`[${linkText}](${convUrl})`);
        if (chat.id) metaBadges.push(`🆔 \`${chat.id}\``);
        if (createdIso) metaBadges.push(`📅 ${new Date(chat.createdAt || createdIso).toLocaleString()}`);
        if (chat.attachmentCount) metaBadges.push(isEn ? `📎 ${chat.attachmentCount} attachments` : `📎 附件 ${chat.attachmentCount} 个`);
        if (metaBadges.length > 0) {
            md += `> ${metaBadges.join(' · ')}\n\n---\n\n`;
        }

        const messages: ChatMessage[] = chat.messages || [];
        if (!messages.length) {
            const emptyNotice = isEn ? '_Empty conversation or fetch failed_' : '_空对话或取回失败_';
            md += `${emptyNotice} URL: ${convUrl}\n`;
            return md;
        }

        // 3. Conversation Messages
        for (const m of messages) {
            const timeStr = m.timestamp ? new Date(m.timestamp).toLocaleString() : '';
            const role = m.role === 'user' ? 'user' : 'model';

            if (role === 'user') {
                md += isEn ? `## 👤 You\n\n` : `## 👤 你\n\n`;
                if (timeStr) md += `> ⏱️ ${timeStr}\n\n`;

                let userAtts = [...(m.attachments || [])];
                if ((m as any).images && (m as any).images.length) {
                    for (const img of (m as any).images) {
                        if (!userAtts.some(a => a.localName === img.localName || a.url === img.url)) {
                            userAtts.push({
                                type: 'image',
                                localName: img.localName || `assets/${img.fileName || 'image.jpg'}`,
                                name: img.fileName || 'image.jpg',
                                src: img.resolvedUrl || img.sourceUrl || img.url
                            } as any);
                        }
                    }
                }
                if ((m as any).documents && (m as any).documents.length) {
                    for (const doc of (m as any).documents) {
                        if (!userAtts.some(a => a.localName === doc.localName || a.url === doc.url)) {
                            userAtts.push({
                                type: 'file',
                                localName: doc.localName || `files/${doc.title || 'doc.md'}`,
                                title: doc.title || 'document',
                                url: doc.url
                            } as any);
                        }
                    }
                }
                if (userAtts.length) {
                    md += renderAttachments(userAtts, isEn);
                }

                const userBody = sanitizeUserPrompt(m.content);
                if (userBody) {
                    md += `${userBody}\n\n`;
                }
            } else {
                md += `## 🤖 Gemini\n\n`;
                if (timeStr) md += `> ⏱️ ${timeStr}\n\n`;

                // Thinking Process (Isolated with double blank lines for strict Markdown parsers)
                const thoughts = ((m as any).thoughts || (m as any).thinking || '').trim();
                if (thoughts) {
                    const thoughtSummary = isEn ? '🧠 Thinking Process' : '🧠 思考过程';
                    md += `<details>\n<summary>${thoughtSummary}</summary>\n\n${thoughts}\n\n</details>\n\n`;
                }

                // AI Answer Content with Heading Hierarchy Protection and Chip Sanitization
                const modelBody = cleanMessageBody(m.content);
                if (modelBody) {
                    const adjusted = adjustHeadingHierarchy(modelBody, 2);
                    md += `${adjusted}\n\n`;
                }

                let modelAtts = [...(m.attachments || [])];
                if ((m as any).images && (m as any).images.length) {
                    for (const img of (m as any).images) {
                        if (!modelAtts.some(a => a.localName === img.localName || a.url === img.url)) {
                            modelAtts.push({
                                type: 'image',
                                localName: img.localName || `assets/${img.fileName || 'image.jpg'}`,
                                name: img.fileName || 'image.jpg',
                                src: img.resolvedUrl || img.sourceUrl || img.url
                            } as any);
                        }
                    }
                }
                if (modelAtts.length) {
                    md += renderAttachments(modelAtts, isEn);
                }

                // Citations / Sources
                if ((m as any).citations && (m as any).citations.length) {
                    const sourceHeader = isEn ? `> 🌐 **Sources:**\n` : `> 🌐 **参考来源：**\n`;
                    md += sourceHeader;
                    (m as any).citations.forEach((c: any, idx: number) => {
                        const citeTitle = c.title || c.url || (isEn ? `Source ${idx + 1}` : `来源 ${idx + 1}`);
                        md += `> [${idx + 1}] [${citeTitle}](${c.url})\n`;
                    });
                    md += `\n`;
                }

                md += `---\n\n`;
            }
        }

        return md;
    }

    /**
     * Convert conversation to OpenAI API Compatible JSON format.
     */
    function toOpenAIJson(chat: any): string {
        const messages = (chat.messages || []).map((m: any) => {
            const role = m.role === 'model' ? 'assistant' : 'user';
            const text = m.content || '';
            const imgs = (m.attachments || []).filter((a: any) => a.type === 'image');
            const item: any = {};

            if (imgs.length > 0) {
                const contentArr: any[] = [];
                if (text) contentArr.push({ type: 'text', text });
                for (const im of imgs) {
                    contentArr.push({
                        type: 'image_url',
                        image_url: {
                            url: im.localName || im.src || im.originalUrl
                        }
                    });
                }
                item.role = role;
                item.content = contentArr;
            } else {
                item.role = role;
                item.content = text;
            }

            const thoughts = (m.thoughts || m.thinking || '').trim();
            if (thoughts) {
                item.reasoning_content = thoughts;
            }

            return item;
        });

        const convUrl = chat.url || (chat.id ? `https://gemini.google.com/app/${String(chat.id).replace(/^c_/, '')}` : '');
        return JSON.stringify({
            id: chat.id,
            title: chat.title,
            url: convUrl,
            created_at: chat.createdAt ? new Date(chat.createdAt).toISOString() : void 0,
            messages: messages
        }, null, 2);
    }

    /**
     * Unified content formatter entry point.
     */
    function formatContent(chat: any, formatType: string = 'markdown', opts: ChatFormatterOptions = {}): FormattedResult {
        if (formatType === 'json_openai') {
            return {
                content: toOpenAIJson(chat),
                ext: 'json',
                mime: 'application/json'
            };
        }
        if (formatType === 'json_raw') {
            return {
                content: JSON.stringify(chat._raw || chat, null, 2),
                ext: 'json',
                mime: 'application/json'
            };
        }
        if (formatType === 'json') {
            return {
                content: JSON.stringify(chat, null, 2),
                ext: 'json',
                mime: 'application/json'
            };
        }
        return {
            content: toMarkdown(chat, opts),
            ext: 'md',
            mime: 'text/markdown'
        };
    }

export {
    adjustHeadingHierarchy,
    renderAttachments,
    convertHtmlToMarkdown,
    cleanMessageBody,
    toMarkdown,
    toOpenAIJson,
    formatContent
};

export const ChatFormatter: ChatFormatterModule = {
    adjustHeadingHierarchy,
    renderAttachments,
    convertHtmlToMarkdown,
    cleanMessageBody,
    toMarkdown,
    toOpenAIJson,
    formatContent
};

(ChatFormatter as any).ChatFormatter = ChatFormatter;
(ChatFormatter as any).default = ChatFormatter;

if (typeof globalThis !== 'undefined' && !(globalThis as any).ChatFormatter) {
    (globalThis as any).ChatFormatter = ChatFormatter;
}
if (typeof module === 'object' && module.exports) {
    module.exports = ChatFormatter;
}
export default ChatFormatter;
