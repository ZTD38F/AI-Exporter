import type { BlockNode } from '../../../l2/content/blocks.js';
import { record, plain } from './toolValues.js';

interface NativeContent { blocks: BlockNode[]; issues: string[] }
/** Preserve authored operations in source order. A Docs edit is labelled as an
 * edit, never presented as a reconstructed final remote document. */
export function parseNativeTool(name: string, input: Record<string, unknown> | null,
    markdown: (text: string) => BlockNode[]): NativeContent | null {
    const blocks: BlockNode[] = [], issues: string[] = [];
    if (['visualize:readme', 'mcpclaudedocsguide'].includes(name)) return { blocks, issues };
    if (name === 'visualize:showwidget') {
        if (typeof input?.widget_code !== 'string' || !input.widget_code.trim()) issues.push('Missing visualization source');
        else blocks.push(plain('Visualization: ' + String(input.title ?? 'Widget')),
            { type: 'code', code: input.widget_code, language: /^\s*<svg\b/.test(input.widget_code) ? 'svg' : 'html' });
    } else if (name === 'taskcreate' || name === 'taskupdate') {
        if (!input || name === 'taskcreate' && typeof input.subject !== 'string'
            || name === 'taskupdate' && typeof input.taskId !== 'string') issues.push('Missing task identity or subject');
        else {
            blocks.push(plain(name === 'taskcreate' ? 'Task: ' + input.subject : 'Task #' + input.taskId));
            for (const key of ['description', 'status']) if (typeof input[key] === 'string') blocks.push(plain(input[key]));
        }
    } else if (name === 'bash') {
        if (typeof input?.command !== 'string') issues.push('Missing shell command');
        else {
            if (typeof input.description === 'string') blocks.push(plain(input.description));
            blocks.push({ type: 'code', code: input.command, language: 'bash' });
        }
    } else if (name === 'senduserfile') {
        const files = input?.files;
        if (!Array.isArray(files) || !files.length
            || !files.every((path): path is string => typeof path === 'string'))
            issues.push('Missing delivered file paths');
        else {
            if (typeof input?.caption === 'string') blocks.push(...markdown(input.caption));
            for (const path of files) blocks.push(plain('Delivered file: ' + path.split('/').at(-1)));
        }
    } else if (name.startsWith('mcpclaudedocs')) {
        const operation = name.slice('mcpclaudedocs'.length);
        if (operation === 'update' && input?.engine === 'prose') {
            const ops = record(input.payload)?.ops;
            if (!Array.isArray(ops) || !ops.length) issues.push('Missing Docs edits');
            else for (const raw of ops) {
                const op = record(raw), replacement = record(op?.with), from = record(replacement?.from);
                const action = String(op?.op);
                if (!['replace', 'insert'].includes(action) || replacement?.as !== 'markdown'
                    || from?.kind !== 'inline' || typeof from.content !== 'string') {
                    issues.push('Unsupported Docs edit'); continue;
                }
                blocks.push(plain('Document edit (' + action + ')'), ...markdown(from.content));
            }
        } else if (operation === 'batch') {
            const doc = record(record(record(input?.container)?.create)?.doc);
            if (doc && typeof doc.markdown === 'string' && Array.isArray(input?.batch) && !input.batch.length) {
                const slots = record(doc.blocks);
                const text = doc.markdown.replace(/<\?claude block ([\w-]+)\?>/g, (_match, key: string) => {
                    const slot = record(slots?.[key]);
                    if (slot?.type === 'pending' && typeof slot.intent === 'string') return 'Planned section: ' + slot.intent;
                    if (slot?.type === 'date' && typeof slot.value === 'string') return slot.value;
                    if (slot?.type === 'mention') return 'Document author';
                    issues.push('Unsupported Docs template block');
                    return '[Unavailable document block]';
                });
                blocks.push(plain('Document created'), ...markdown(text));
            } else issues.push('Unsupported Docs batch operation');
        } else if (operation === 'create' && input?.object === 'utterance') {
            const value = record(record(input.payload)?.value);
            if (typeof value?.body === 'string') blocks.push(plain('Document comment'), ...markdown(value.body));
            else issues.push('Missing document comment');
        } else issues.push('Unsupported Docs operation: ' + operation);
    } else return null;
    return { blocks, issues };
}
export function isNativeSetupResult(name: string): boolean {
    return ['visualize:readme', 'visualize:showwidget', 'mcpclaudedocsguide'].includes(name);
}

/** Some native receipts append setup prose after the JSON object. */
export function nativeReceipt(text: string): Record<string, unknown> | null {
    let depth = 0, quoted = false, escaped = false;
    const value = text.trimStart();
    if (!value.startsWith('{')) return null;
    for (let i = 0; i < value.length; i++) {
        const c = value[i];
        if (quoted) {
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === '"') quoted = false;
        } else if (c === '"') quoted = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return record(JSON.parse(value.slice(0, i + 1)));
    }
    return null;
}
