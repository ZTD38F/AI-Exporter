import { unescapeHtml } from "../../utils/utils.js";

function stripHtmlTags(str: string): string {
    let prev = '';
    let current = str;
    do {
        prev = current;
        current = current.replace(/<[^>]+>/g, '');
    } while (current !== prev);
    return current;
}

export function convertHtmlToMarkdown(html?: string | null): string {
    if (!html || typeof html !== 'string') return html || '';
    if (!/<(?:pre|code|p|h[1-6]|ul|ol|li|blockquote|strong|b|em|i|table)[\s>]/i.test(html)) return html;

    let res = html;
    res = res.replace(/<pre><code(?:\s+class=["'](?:language-)?([a-z0-9_-]+)["'])?>([\s\S]*?)<\/code><\/pre>/gi, (_match, lang, code) => {
        const cleanCode = unescapeHtml(code);
        return `\n\`\`\`${lang || ''}\n${cleanCode.trim()}\n\`\`\`\n`;
    });
    res = res.replace(/<code>([\s\S]*?)<\/code>/gi, (_match, code) => {
        return `\`${unescapeHtml(code)}\``;
    });
    // Protect fenced and inline code blocks before processing HTML tags
    const __codeSpans: string[] = [];
    const __stashCode = (code: string): string => {
        __codeSpans.push(code);
        return `\uFFFDCODE${__codeSpans.length - 1}\uFFFD`;
    };
    const __restoreCode = (str: string): string =>
        str.replace(/\uFFFDCODE(\d+)\uFFFD/g, (_m, i) => __codeSpans[Number(i)]);
    res = res.replace(/```[\s\S]*?```/g, __stashCode).replace(/`[^`\n]+`/g, __stashCode);
    res = res.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl, txt) => `\n${'#'.repeat(parseInt(lvl, 10))} ${txt.trim()}\n`);
    res = res.replace(/<(strong|b)(?=[\s/>])[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
    res = res.replace(/<(em|i)(?=[\s/>])[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
    res = res.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_match, tableContent) => {
        const rows: string[] = [];
        const trMatches = tableContent.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
        let isFirstRow = true;
        let colCount = 0;

        for (const trMatch of trMatches) {
            const trContent = trMatch[1];
            const cells: string[] = [];
            const cellMatches = trContent.matchAll(/<(?:th|td)[^>]*>([\s\S]*?)<\/(?:th|td)>/gi);
            for (const cMatch of cellMatches) {
                let cell = cMatch[1];
                cell = cell.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1<br>');
                cell = cell.replace(/<br\s*\/?>/gi, '__TABLE_BR__');
                cell = stripHtmlTags(cell);
                cell = unescapeHtml(cell);
                cell = cell.replace(/\r?\n/g, ' ').trim();
                cell = cell.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
                cells.push(cell);
            }
            if (cells.length === 0) continue;
            if (isFirstRow) {
                colCount = cells.length;
                rows.push('| ' + cells.join(' | ') + ' |');
                rows.push('| ' + new Array(colCount).fill('---').join(' | ') + ' |');
                isFirstRow = false;
            } else {
                while (cells.length < colCount) cells.push('');
                rows.push('| ' + cells.slice(0, colCount).join(' | ') + ' |');
            }
        }
        return rows.length > 0 ? '\n\n' + rows.join('\n') + '\n\n' : '';
    });
    res = res.replace(/<br\s*\/?>/gi, '\n');
    res = res.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n');
    res = stripHtmlTags(res);
    res = __restoreCode(res);
    res = res.replace(/__TABLE_BR__/g, '<br>');
    return res;
}
