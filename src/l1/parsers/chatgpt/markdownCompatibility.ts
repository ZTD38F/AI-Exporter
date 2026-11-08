/**
 * ChatGPT Markdown dialect normalization (provider preprocessing).
 * The shared mdast parser stays generic; dialect quirks end here, mirroring
 * parsers/gemini/shared/markdownCompatibility.ts.
 *
 * ChatGPT emits:
 * - display math as `\\[ ... \\]` and inline math as `\\( ... \\)`
 *   (normalized to `$$` / `$`, which the shared math extension parses);
 * - telemetry citation markers in Unicode private-use code points
 *   (`cite turn0search0`); stripped so exports stay telemetry-free;
 * - raw HTML (notably `<br>` inside tables); tags are dropped, `<br>` folds
 *   to a space so table cells do not glue words together.
 */

// Fenced code blocks and inline code keep their backslashes and dollars.
const CODE_SPAN = /(```[\s\S]*?(?:```|$)|`[^`\n]+`)/g;

// Own-line `\[ ... \]` -> `$$` block; anywhere `\[...\]` -> `$$...$$`;
// `\(...\)` -> `$...$`. Code spans are shielded by the caller.
const BRACKET_DISPLAY_OWN_LINES = /^[ \t]*\\\[(?<block>[\s\S]+?)\\\][ \t]*$/gm;
const BRACKET_DISPLAY_INLINE = /\\\[(?<display>[\s\S]+?)\\\]/g;
// An unclosed opener must not absorb a later formula or a different table row.
const BRACKET_INLINE = /\\\((?<inline>(?:(?!\\\()[^\r\n])+?)\\\)/g;

// Citation markers are framed by private-use delimiters. Two shapes observed
// live (2026-10-14):
// - `<U+E200>cite<U+E202>turn388160search0<U+E202>turn388160search1<U+E201>`
//   references search-result indices (kept structurally in metadata); the
//   marker itself is telemetry noise and is stripped;
// - `<U+E200>url<U+E202>{title}<U+E202>{url}<U+E201>` carries a real source
//   link and is rewritten to Markdown so the reference survives.
// Normal prose never interleaves PUA code points this way. Lone PUA strays
// are dropped too.
const URL_CITATION = /[\uE200][\uE000-\uF8FF]*url[\uE000-\uF8FF]*([^\uE000-\uF8FF]*?)[\uE000-\uF8FF]*([^\uE000-\uF8FF]*?)[\uE201]/g;
const CITE_MARKER = /[\uE200][\uE000-\uF8FF]*cite(?:[\uE000-\uF8FF]*turn[0-9a-z]*)+[\uE000-\uF8FF]*/g;
const PUA_STRAY = /[\uE000-\uF8FF]+/g;

function stripCitationsOutsideCode(text: string): string {
    return text
        .replace(URL_CITATION, (_m: string, title: string, url: string) => `[${title.trim()}](${url.trim()})`)
        .replace(CITE_MARKER, '')
        .replace(PUA_STRAY, '');
}

const BR_TAG = /<br\s*\/?>/gi;

function normalizeMathOutsideCode(text: string): string {
    return text
        .replace(BRACKET_DISPLAY_OWN_LINES, (_m, block: string) => `$$\n${block}\n$$`)
        .replace(BRACKET_DISPLAY_INLINE, (_m, display: string) => `$$${display}$$`)
        .replace(BRACKET_INLINE, (_m, inline: string) => `$${inline}$`);
}

/** Normalize one ChatGPT message body for the shared Markdown parser. */
export function preprocessChatGPTMarkdown(source: string): string {
    if (!source) return source;
    // Shield code spans from every rewrite below.
    const parts = source.split(CODE_SPAN);
    for (let i = 0; i < parts.length; i += 2) {
        let part = parts[i] ?? '';
        part = normalizeMathOutsideCode(part);
        part = stripCitationsOutsideCode(part);
        part = part.replace(BR_TAG, ' ');
        parts[i] = part;
    }
    return parts.join('');
}
