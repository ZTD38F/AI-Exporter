/** Grok uses TeX brackets; protect fenced and inline code before normalizing them. */
export function preprocessGrokMarkdown(source: string): string {
    const parts = source.split(/(`{3,}[^]*?(?:`{3,}|$)|~{3,}[^]*?(?:~{3,}|$)|`+[^`\n]*`+)/g);
    for (let i = 0; i < parts.length; i += 2) {
        parts[i] = parts[i].replace(/\\\(([^\n]*?)\\\)/g, (_match, body: string) => '$' + body + '$')
            .replace(/\\\[([^]*?)\\\]/g, (_match, body: string) => '\n$$\n' + body + '\n$$\n');
    }
    return parts.join('');
}
