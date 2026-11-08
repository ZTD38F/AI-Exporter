import { expression, type Scope } from './expression.js';
import { attribute, type DilNode } from './syntax.js';

const layoutComponents = new Set(['box', 'row', 'column', 'grid', 'grid-item', 'text', 'p', 'label', 'caption', 'strong', 'em']);
const controlComponents = new Set(['radio-group', 'checkbox-group', 'radio', 'checkbox', 'button', 'select', 'option', 'input']);
const descriptions: Record<string, string> = {
    COMPOUND_INTEREST: 'Explains compound interest and continuous growth or discounting.',
    VARIANCE: 'Explains variance from squared deviations around a mean.',
    ANGULAR_FREQUENCY_RELATION: 'Shows the relationship between angular frequency and ordinary frequency.',
};
function prop(node: DilNode, name: string, scope: Scope): ReturnType<typeof expression> | undefined {
    const source = attribute(node, name);
    return source === undefined ? undefined : expression(source.startsWith('{') ? source.slice(1, -1) : source, scope);
}
function codeFence(value: string, language: string): string {
    const longest = Math.max(2, ...[...value.matchAll(/`+/g)].map(match => match[0].length));
    const fence = '`'.repeat(longest + 1);
    return `\n\n${fence}${language}\n${value.replace(/^\n/, '').replace(/\n\s*$/, '')}\n${fence}\n\n`;
}

/** Render only documented static representations. UI layout props and event
 * handlers never become output text. Child ordering is handled by the walker. */
export function component(node: DilNode, content: string, scope: Scope, source: string): string {
    if (layoutComponents.has(node.name)) {
        if (node.name === 'strong') return `**${content.trim()}**`;
        if (node.name === 'em') return `*${content.trim()}*`;
        return `\n\n${content.trim()}\n\n`;
    }
    if (node.name === 'title') return `\n\n**${content.trim()}**\n\n`;
    if (node.name === 'divider') return '\n\n---\n\n';
    if (node.name === 'br') return '  \n';
    if (node.name === 'icon') return '';
    if (node.name === 'CodeBlock') {
        const language = prop(node, 'language', scope);
        if (language !== undefined && (typeof language !== 'string' || !/^[\w+-]*$/.test(language))) throw new Error('Invalid code language');
        return codeFence(content, language ?? '');
    }
    if (node.name === 'svg') return codeFence(source.slice(node.start, node.end).replace(
        /\b(strokeWidth|fontSize|textAnchor|strokeLinecap|strokeLinejoin|fillRule|clipRule)(?=\s*=)/g,
        name => name.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase())), 'svg');
    if (node.name === 'AsyncImage') {
        const query = prop(node, 'query', scope);
        if (typeof query !== 'string') throw new Error('Missing literal image query');
        // The existing gallery resolver binds this to approved componentResults
        // and promotes the image to a Domain asset. No URL is invented here.
        return `\n\n\uE200image_group\uE202${JSON.stringify({ query: [query] })}\uE201\n\n`;
    }
    if (node.name === 'math') {
        const value = prop(node, 'value', scope);
        if (typeof value !== 'string') throw new Error('Missing math source');
        return prop(node, 'block', scope) === true ? `\n\n\\[\n${value}\n\\]\n\n` : `\\(${value}\\)`;
    }
    if (node.name === 'LearningViz') {
        const id = prop(node, 'type_id', scope);
        if (typeof id !== 'string' || !Object.hasOwn(descriptions, id)) throw new Error('Unsupported learning visualization');
        const values = prop(node, 'initial_values', scope);
        let initial = '';
        if (values !== undefined) {
            if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Invalid learning values');
            initial = '\n\n初始值:\n' + Object.entries(values).map(([key, value]) => {
                if (value !== null && typeof value === 'object') throw new Error('Non-scalar learning value');
                return `- ${key}: ${String(value)}`;
            }).join('\n');
        }
        return `\n\n${descriptions[id]}${initial}${content.trim() ? '\n\n' + content.trim() : ''}\n\n`;
    }
    if (controlComponents.has(node.name)) {
        if (node.name === 'input') {
            const placeholder = prop(node, 'placeholder', scope);
            const initial = prop(node, 'value', scope);
            if (initial !== undefined && initial !== null && typeof initial === 'object') throw new Error('Non-scalar input value');
            // Provider source holds defaults, not the user's live input state.
            const label = typeof placeholder === 'string'
                ? `[输入框占位文本：${placeholder}]（当前值不可用。）` : '[输入框的值不可用]';
            return `\n\n${label}${initial === undefined ? '' : '\n\n初始值：' + String(initial)}\n\n`;
        }
        if (node.name === 'button') return `\n\n[${content.trim()}]\n\n`;
        if (['radio', 'checkbox', 'option'].includes(node.name)) return `\n- ${content.trim()}\n`;
        return `\n\n${content.trim()}\n\n`;
    }
    throw new Error(`Unsupported component: ${node.name}`);
}
