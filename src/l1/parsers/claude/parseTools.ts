import { parseNativeTool, isNativeSetupResult, nativeReceipt } from './parseNativeTools.js';
import type { BlockNode } from '../../../l2/content/blocks.js';
import type { ClaudeSourceMessage, ClaudeSourceFile, ClaudeToolUse, ClaudeToolResult } from './decodeDetail.js';

import { record, plain } from './toolValues.js';
interface ToolContent { blocks: BlockNode[]; issues: string[] }
const toolName = (value: string) => value.replace(/_/g, '').toLowerCase();
export interface ToolState { files: Map<string, string>; artifactPaths: Set<string> }
export function createToolState(messages: ClaudeSourceMessage[]): ToolState {
    const artifactPaths = new Set<string>();
    for (const message of messages) for (const block of message.content ?? []) {
        if (block.kind === 'tool_use' && toolName(block.name) === 'artifact'
            && typeof block.input?.file_path === 'string') artifactPaths.add(block.input.file_path);
    }
    return { files: new Map(), artifactPaths };
}
/** A generated file card is already covered only by one exact captured publish.
 * A matching filename alone is insufficient evidence for attachment bytes. */
export function isCapturedArtifactFile(message: ClaudeSourceMessage, file: ClaudeSourceFile,
    state: ToolState): boolean {
    if (!file.success || file.fileKind !== 'blob' || file.downloadSource !== 'files-api'
        || file.fileName === undefined || file.sizeBytes === undefined) return false;
    const paths = new Set<string>();
    for (const block of message.content ?? []) {
        if (block.kind === 'tool_use' && toolName(block.name) === 'artifact'
            && typeof block.input?.file_path === 'string' && block.input.edits === undefined
            && block.input.file_path.split('/').at(-1) === file.fileName) paths.add(block.input.file_path);
    }
    if (paths.size !== 1) return false;
    const content = state.files.get([...paths][0]);
    return content !== undefined && new TextEncoder().encode(content).byteLength === file.sizeBytes;
}
function memoryOperation(value: string): string | undefined {
    const name = toolName(value).replace(/^mcpmemory/, '');
    return ['memoryread', 'memorywrite', 'memoryappend'].includes(name) ? name.slice(6) : undefined;
}
function fileBlocks(label: string, path: string, content: string): BlockNode[] {
    const extension = path.split('.').at(-1)?.toLowerCase();
    const language = extension === 'py' ? 'python' : extension === 'js' ? 'javascript'
        : extension === 'ts' ? 'typescript' : extension;
    return [plain(label + ': ' + path.split('/').at(-1)),
        { type: 'code', code: content, ...(language ? { language } : {}) }];
}
function link(label: string, url: unknown): BlockNode {
    // Untrusted source URLs must never turn into executable links.
    return typeof url === 'string' && /^https?:\/\//i.test(url)
        ? { type: 'paragraph', children: [{ type: 'link', href: url,
            children: [{ type: 'text', text: label }] }] } : plain(label);
}

/** Native widgets are projected into shared semantic blocks, without exporting internal tool inputs. */
export function parseToolUse(block: ClaudeToolUse, state: ToolState,
    markdown: (text: string) => BlockNode[] = text => [plain(text)]): ToolContent {
    const input = block.input;
    const name = toolName(block.name);
    const blocks: BlockNode[] = [], issues: string[] = [];
    // Shell execution may mutate any retained file; only a subsequent explicit
    // Write can establish fresh bytes for an inline Artifact projection.
    if (name === 'bash') state.files.clear();
    const native = parseNativeTool(name, input, markdown);
    if (native) return native;
    if (name === 'artifacts') {
        if (typeof input?.content === 'string' && (input.command === undefined || input.command === 'create')) {
            blocks.push(plain('Artifact: ' + (typeof input.title === 'string' ? input.title : 'Artifact')),
                { type: 'code', code: input.content,
                    ...(typeof input.language === 'string' ? { language: input.language } : {}) });
        } else issues.push('Unsupported artifact operation or missing artifact content');
    } else if (name === 'write') {
        if (typeof input?.file_path === 'string' && typeof input.content === 'string') {
            state.files.set(input.file_path, input.content);
            if (!state.artifactPaths.has(input.file_path))
                blocks.push(...fileBlocks('File', input.file_path, input.content));
        } else issues.push('Missing written file path or content');
    } else if (name === 'artifact' && input?.action === 'open' && typeof input.url === 'string') {
        blocks.push(link('Artifact', input.url));
    } else if (name === 'artifact') {
        const path = input?.file_path;
        if (typeof path === 'string') {
            const content = state.files.get(path);
            if (content !== undefined && input?.edits === undefined) {
                blocks.push(...fileBlocks('Artifact', path, content));
                if (typeof input?.description === 'string') blocks.push(plain(input.description));
            } else {
                state.files.delete(path);
                issues.push('Published artifact content is unavailable or uses unsupported edits');
            }
        } else issues.push('Published artifact content is unavailable or uses unsupported edits');
    } else if (name === 'askuserquestion') {
        if (!Array.isArray(input?.questions) || !input.questions.length) issues.push('Missing questionnaire questions');
        else for (const raw of input.questions) {
            const question = record(raw);
            if (!question || typeof question.question !== 'string' || !question.question.trim()) {
                issues.push('Invalid questionnaire question'); continue;
            }
            if (typeof question.header === 'string') blocks.push(plain(question.header));
            blocks.push(plain(question.question));
            if (typeof question.multiSelect === 'boolean')
                blocks.push(plain(question.multiSelect ? 'Multiple selections allowed' : 'Single selection'));
            if (!Array.isArray(question.options) || !question.options.length) {
                issues.push('Missing questionnaire options'); continue;
            }
            const items: { blocks: BlockNode[] }[] = [];
            for (const rawOption of question.options) {
                const option = record(rawOption);
                if (!option || typeof option.label !== 'string' || !option.label.trim()) {
                    issues.push('Invalid questionnaire option'); continue;
                }
                items.push({ blocks: [plain(option.label),
                    ...(typeof option.description === 'string' ? [plain(option.description)] : [])] });
            }
            blocks.push({ type: 'list', ordered: false, items });
        }
    } else if (name === 'websearch') {
        if (typeof input?.query === 'string') blocks.push(plain('Web search: ' + input.query));
        else issues.push('Missing web search query');
    } else if (memoryOperation(block.name)) {
        // Memory persistence is an operational side effect, not an authored Artifact.
        blocks.push(plain('Memory ' + memoryOperation(block.name)));
    } else if (['toolsearch', 'listconnectors', 'searchmcpregistry', 'suggestconnectors', 'skill'].includes(name)) {
        // Discovery parameters/registry IDs are orchestration metadata. The associated
        // result carries the actual connector cards or tool references.
    } else {
        // An unparsed file operation could have changed the retained source.
        // Do not reuse old bytes for a later publish of that file.
        if (typeof input?.file_path === 'string') state.files.delete(input.file_path);
        issues.push('Unsupported tool: ' + String(block.name ?? 'unknown'));
    }
    if (issues.length) blocks.push({ type: 'unknown', sourceType: 'claude.tool_use',
        text: 'Tool: ' + String(block.name ?? 'unknown') });
    return { blocks, issues };
}

function connectorCards(text: string): ToolContent {
    const blocks: BlockNode[] = [], issues: string[] = [];
    let value: unknown;
    try { value = JSON.parse(text); } catch { return { blocks: [plain(text)], issues: ['Invalid connector result JSON'] }; }
    const entries = Array.isArray(value) ? value : record(value)?.results;
    if (!Array.isArray(entries)) return { blocks: [plain(text)], issues: ['Missing connector result list'] };
    if (!entries.length) blocks.push(plain('No connectors found'));
    for (const entry of entries) {
        const card = record(entry);
        if (!card || typeof card.name !== 'string') { issues.push('Invalid connector card'); continue; }
        blocks.push(link(card.name, card.url));
        if (typeof card.description === 'string') blocks.push(plain(card.description));
    }
    return { blocks, issues };
}

export function parseToolResult(block: ClaudeToolResult,
    parseMarkdown: (text: string) => BlockNode[]): ToolContent {
    const name = toolName(block.name);
    const blocks: BlockNode[] = [], issues: string[] = [];
    // Keep execution outcome, but omit internal version tokens and stored profile bodies.
    const operation = memoryOperation(block.name);
    if (operation && !block.isError) {
        blocks.push(plain('Memory ' + operation + ' completed'));
        return { blocks, issues };
    }
    if ((['skill', 'write'].includes(name) || isNativeSetupResult(name)) && !block.isError) {
        // Skill setup text is orchestration metadata, not authored output.
        return { blocks, issues };
    }
    if (name === 'senduserfile' && !block.isError) return { blocks: [plain('Files delivered')], issues };
    if (name === 'toolsearch') {
        for (const ref of block.references) blocks.push(plain('Available tool: ' + ref));
    }
    if (!block.parts) issues.push('Missing tool result content');
    else for (const part of block.parts) {
        if (part.kind === 'text') {
            if (!part.text.trim()) continue;
            if (name === 'artifact' && !block.isError) {
                const url = part.text.match(/https:\/\/claude\.ai\/artifact\/[A-Za-z0-9_-]+/)?.[0];
                if (url) blocks.push(link('Published artifact', url));
                else issues.push('Missing published artifact link');
            } else if (name === 'bash') {
                blocks.push({ type: 'code', code: part.text, language: 'text' });
            } else if (name.startsWith('mcpclaudedocs') && !block.isError) {
                try {
                    const result = nativeReceipt(part.text);
                    if (result?.verdict !== 'allow') issues.push('Docs operation did not succeed');
                    else blocks.push(plain('Document operation completed'));
                } catch { issues.push('Invalid Docs operation receipt'); }
            } else if (['listconnectors', 'searchmcpregistry', 'suggestconnectors'].includes(name)) {
                const parsed = connectorCards(part.text);
                blocks.push(...parsed.blocks); issues.push(...parsed.issues);
            } else blocks.push(...parseMarkdown(part.text));
        } else if (part.kind === 'knowledge') {
            blocks.push(link(part.title, part.url));
            if (part.url === undefined || !/^https?:\/\//i.test(part.url))
                issues.push('Missing or unsafe search result URL');
            if (part.text !== undefined) blocks.push(...parseMarkdown(part.text));
            if (part.isMissing) issues.push('Missing search result content');
        } else {
            issues.push('Unsupported tool result content: ' + part.sourceType);
            blocks.push({ type: 'unknown', sourceType: 'claude.tool_result', text: 'Unsupported tool result content' });
        }
    }
    if (block.isError) blocks.unshift(plain('Tool execution failed'));
    return { blocks, issues };
}
