import { describeFixtures, synthetic } from './provenance.js';
/** Raw GET /api/organizations/:org/chat_conversations/:id response bodies.
 * Every key supplies an independent, fixed native reply; no scenarios or options.
 */
const conversation = '11111111-1111-4111-8111-111111111111';
const root = '33333333-3333-4333-8333-333333333333';
const branch = '44444444-4444-4444-8444-444444444444';
const leaf = '55555555-5555-4555-8555-555555555555';

function message(uuid: string, parent: string | null, sender: string, text: string) {
    return { uuid, parent_message_uuid: parent, sender,
        content: [{ type: 'text', text }], created_at: '2026-10-01T00:00:00.000Z' };
}

type RawClaudeMessage = { uuid: string; [sourceField: string]: unknown };
function detail(messages: RawClaudeMessage[], currentLeaf: string | null = leaf) {
    return { uuid: conversation, name: 'Claude authored title', created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-02T00:00:00Z', chat_messages: messages,
        current_leaf_message_uuid: currentLeaf };
}

function nativeWidgets() {
    return [
        { type: 'tool_use', name: 'visualize:read_me', input: { modules: ['diagram'] } },
        { type: 'tool_result', name: 'visualize:read_me', content: [{ type: 'text', text: 'PRIVATE SETUP' }] },
        { type: 'tool_use', name: 'visualize:show_widget', input: { title: 'Cutaway', widget_code: '<svg><title>Resonator</title></svg>' } },
        { type: 'tool_use', name: 'TaskCreate', input: { subject: 'Compute', description: 'Validate units' } },
        { type: 'tool_use', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'python3 demo.py' } },
        { type: 'tool_result', name: 'Bash', content: [{ type: 'text', text: '  f = 149.44\n' }] },
        { type: 'tool_use', name: 'mcp__Claude_Docs__update', input: { engine: 'prose', payload: { ops: [
            { op: 'replace', with: { as: 'markdown', from: { kind: 'inline', content: '## Derivation\n\n**Full** derivation.' } } },
        ] } } },
        { type: 'tool_result', name: 'mcp__Claude_Docs__update', content: [{ type: 'text', text: '{"verdict":"allow","xml":"<doc>…</doc>"}\nInternal setup instructions.' }] },
        { type: 'tool_use', name: 'mcp__Claude_Docs__create', input: { object: 'utterance', payload: { value: { body: 'Confirm the chosen units?' } } } },
        { type: 'tool_use', name: 'Artifact', input: { action: 'open', url: 'https://claude.ai/artifact/example' } },
        { type: 'tool_use', name: 'SendUserFile', input: { files: ['/home/claude/result.py'], caption: 'Runnable result' } },
        { type: 'tool_result', name: 'SendUserFile', content: [{ type: 'text', text: 'file_uuid: PRIVATE-FILE-ID. INTERNAL FILE CARD INSTRUCTIONS' }] },
    ];
}

const fixtureMap = {
    'CL_L1_SOURCE_SELECTED_BRANCH_01': () => detail([
        message(root, null, 'human', 'Question'),
        message(branch, root, 'assistant', 'Abandoned answer'),
        message(leaf, root, 'assistant', 'Selected **answer**'),
    ]),
    'CL_L1_SOURCE_MISSING_PARENT_01': () => detail([message(leaf, root, 'assistant', 'Answer')]),
    'CL_L1_SOURCE_MISSING_LEAF_01': () => detail([message(root, null, 'human', 'Question')], null),
    'CL_L1_SOURCE_FOREIGN_CONVERSATION_01': () => detail([]),
    'CL_L1_SOURCE_MISSING_MESSAGES_01': () => ({ uuid: conversation }),
    'CL_L1_SOURCE_SENTINEL_ROOT_01': () => detail([
        message(root, '00000000-0000-4000-8000-000000000000', 'human', 'Q'),
        message(leaf, root, 'assistant', 'A'),
    ]),
    'CL_L1_SOURCE_UNRESOLVED_PARENT_01': () => detail([message(leaf, branch, 'assistant', 'Missing')]),
    'CL_L1_SOURCE_CYCLIC_BRANCH_01': () => detail([
        message(root, leaf, 'human', 'Q'),
        message(leaf, root, 'assistant', 'Cycle'),
    ]),
    'CL_L1_SOURCE_MARKDOWN_ARTIFACTS_01': () => detail([
        message(root, null, 'human', 'Hello'),
        { uuid: leaf, parent_message_uuid: root, sender: 'assistant',
            content: [{ type: 'thinking', thinking: 'Consider the task' },
                { type: 'text', text: 'Answer with \\(x^2\\)' },
                { type: 'tool_use', name: 'artifacts', input: { title: 'app.ts', language: 'typescript', content: 'export const n = 42;' } }],
            attachments: [{ file_name: 'notes.txt', extracted_content: 'document text' }] },
    ]),
    'CL_L1_SOURCE_MISSING_BINARY_FILE_01': () => detail([
        message(root, null, 'human', 'Hi'),
        { ...message(leaf, root, 'assistant', 'Answer'), files: [{ name: 'unavailable.pdf' }] },
    ]),
    'CL_L1_SOURCE_QUESTIONNAIRE_FULL_01': () => detail([
        message(root, null, 'human', 'Help'),
        { ...message(leaf, root, 'assistant', ''), content: [
            { type: 'tool_use', id: 'question', name: 'AskUserQuestion', input: { questions: [
                { header: 'Work', question: 'Which role?', multiSelect: false,
                    options: [{ label: 'Engineer', description: 'Build software' }, { label: 'Researcher', description: 'Study systems' }] },
                { header: 'Tools', question: 'Which tools?', multiSelect: true,
                    options: [{ label: 'Editor', description: 'Write code' }, { label: 'Calendar', description: 'Plan time' }] },
            ] } },
            { type: 'tool_result', tool_use_id: 'question', name: 'AskUserQuestion',
                content: [{ type: 'text', text: 'Selected: Engineer, Editor, Calendar' }] },
            { type: 'tool_use', id: 'search', name: 'web_search', input: { query: 'Export documentation' } },
            { type: 'tool_result', tool_use_id: 'search', name: 'web_search', content: [
                { type: 'knowledge', title: 'Source article', url: 'https://example.com/article', is_missing: false },
            ] },
            { type: 'tool_use', id: 'connector', name: 'SuggestConnectors', input: { uuids: ['internal-id'] } },
            { type: 'tool_result', tool_use_id: 'connector', name: 'suggest_connectors', content: [{ type: 'text',
                text: JSON.stringify([{ name: 'Example connector', description: 'Read calendar entries', url: 'https://example.com/connect' }]) }] },
        ] },
    ]),
    'CL_L1_SOURCE_MEMORY_WRITE_01': () => detail([
        message(root, null, 'human', 'Hello'),
        { ...message(leaf, root, 'assistant', ''), content: [
            { type: 'tool_use', name: 'mcp__memory__memory_write', input: { path: '/profile.md', content: 'internal profile body' } },
            { type: 'tool_result', name: 'memory_write', content: [{ type: 'text', text: 'internal version token' }],
                structured_content: { parsed: { body: 'internal profile body' } } },
            { type: 'tool_use', name: 'artifacts', input: { title: 'App', content: 'const answer = 42;', language: 'javascript' } },
        ] },
    ]),
    'CL_L1_SOURCE_BAD_WIDGET_01': () => detail([
        message(root, null, 'human', 'Q'),
        { ...message(leaf, root, 'assistant', ''), content: [
            { type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'Which?', options: [{}] }] } },
        ] },
    ]),
    'CL_L1_SOURCE_BAD_WIDGET_02': () => detail([
        message(root, null, 'human', 'Q'),
        { ...message(leaf, root, 'assistant', ''), content: [
            { type: 'tool_use', name: 'future_widget', input: {} },
        ] },
    ]),
    'CL_L1_SOURCE_BAD_WIDGET_03': () => detail([
        message(root, null, 'human', 'Q'),
        { ...message(leaf, root, 'assistant', ''), content: [
            { type: 'tool_result', name: 'future_widget', content: [{ type: 'image', data: 'unavailable' }] },
        ] },
    ]),
    'CL_L1_SOURCE_BAD_WIDGET_04': () => detail([
        message(root, null, 'human', 'Q'),
        { ...message(leaf, root, 'assistant', ''), content: [
            { type: 'tool_result', name: 'web_search', content: [{ type: 'knowledge', title: 'Missing', is_missing: true }] },
        ] },
    ]),
    'CL_L1_SOURCE_BAD_WIDGET_05': () => detail([
        message(root, null, 'human', 'Q'),
        { ...message(leaf, root, 'assistant', ''), content: [
            { type: 'tool_result', name: 'suggest_connectors', content: [{ type: 'text', text: '{broken' }] },
        ] },
    ]),
    'CL_L1_SOURCE_WRITE_ARTIFACT_01': () => detail([
        message(root, null, 'human', 'Create a checklist'),
        { ...message(leaf, root, 'assistant', ''), content: [
            { type: 'tool_use', name: 'Skill', input: { skill: 'artifact-design' } },
            { type: 'tool_result', name: 'Skill', content: [{ type: 'text', text: 'internal skill setup' }] },
            { type: 'tool_use', name: 'Write', input: { file_path: '/home/claude/checklist.html',
                content: '<h1>Backup checklist</h1>\n<script>window.example = "inert source";</script>' } },
            { type: 'tool_result', name: 'Write', content: [{ type: 'text', text: 'File created successfully' }] },
            { type: 'tool_use', name: 'Artifact', input: { file_path: '/home/claude/checklist.html', description: 'Four backup steps' } },
            { type: 'tool_result', name: 'Artifact', content: [{ type: 'text',
                text: 'Published at https://claude.ai/artifact/example-123 (Version 1). Internal publication instructions.' }] },
        ] },
    ]),
    'CL_L1_SOURCE_MEMORY_READ_01': () => detail([
        message(root, null, 'human', 'Q'),
        { ...message(leaf, root, 'assistant', 'A'), content: [
            { type: 'tool_use', name: 'mcp__memory__memory_read', input: { content: 'private memory input' } },
            { type: 'tool_result', name: 'memory_read', content: [{ type: 'text', text: 'private memory body and version token' }] },
        ] },
    ]),
    'CL_L1_SOURCE_MEMORY_APPEND_01': () => detail([
        message(root, null, 'human', 'Q'),
        { ...message(leaf, root, 'assistant', 'A'), content: [
            { type: 'tool_use', name: 'mcp__memory__memory_append', input: { content: 'private memory input' } },
            { type: 'tool_result', name: 'memory_append', content: [{ type: 'text', text: 'private memory body and version token' }] },
        ] },
    ]),
    'CL_L1_SOURCE_UNAVAILABLE_ARTIFACT_01': () => detail([
        message(root, null, 'human', 'Q'),
        { ...message(leaf, root, 'assistant', ''), content: [
            { type: 'tool_use', name: 'Artifact', input: { file_path: '/tmp/app.html' } },
        ] },
    ]),
    'CL_L1_SOURCE_UNPARSED_ARTIFACT_EDIT_01': () => detail([
        message(root, null, 'human', 'Q'),
        { ...message(leaf, root, 'assistant', ''), content: [
            { type: 'tool_use', name: 'Write', input: { file_path: '/tmp/app.html', content: 'old source must not be reused' } },
            { type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/app.html', old_string: 'before', new_string: 'after' } },
            { type: 'tool_use', name: 'Artifact', input: { file_path: '/tmp/app.html' } },
        ] },
    ]),
    'CL_L1_SOURCE_FILE_CARD_MATCHING_01': () => detail([
        message(root, null, 'human', 'Q'),
        { ...message(leaf, root, 'assistant', ''), content: [
            { type: 'tool_use', name: 'Write', input: { file_path: '/home/claude/checklist.html', content: '<h1>中文清单</h1>' } },
            { type: 'tool_use', name: 'Artifact', input: { file_path: '/home/claude/checklist.html' } },
        ], files: [{ success: true, file_kind: 'blob', download_source: 'files-api',
            file_name: 'checklist.html', size_bytes: new TextEncoder().encode('<h1>中文清单</h1>').byteLength }] },
    ]),
    'CL_L1_SOURCE_FILE_CARD_WRONG_SIZE_01': () => detail([
        message(root, null, 'human', 'Q'),
        { ...message(leaf, root, 'assistant', ''), content: [
            { type: 'tool_use', name: 'Write', input: { file_path: '/home/claude/checklist.html', content: '<h1>中文清单</h1>' } },
            { type: 'tool_use', name: 'Artifact', input: { file_path: '/home/claude/checklist.html' } },
        ], files: [{ success: true, file_kind: 'blob', download_source: 'files-api',
            file_name: 'checklist.html', size_bytes: '<h1>中文清单</h1>'.length }] },
    ]),
    'CL_L1_SOURCE_FILE_CARD_UNRELATED_01': () => detail([
        message(root, null, 'human', 'Q'),
        { ...message(leaf, root, 'assistant', ''), content: [
            { type: 'tool_use', name: 'Write', input: { file_path: '/home/claude/checklist.html', content: '<h1>中文清单</h1>' } },
            { type: 'tool_use', name: 'Artifact', input: { file_path: '/home/claude/checklist.html' } },
        ], files: [{ success: true, file_kind: 'blob', download_source: 'files-api',
            file_name: 'other.html', size_bytes: new TextEncoder().encode('<h1>中文清单</h1>').byteLength }] },
    ]),
    'CL_L1_SOURCE_FILE_CARD_UPLOADED_01': () => detail([
        message(root, null, 'human', 'Q'),
        { ...message(leaf, root, 'assistant', ''), content: [
            { type: 'tool_use', name: 'Write', input: { file_path: '/home/claude/checklist.html', content: '<h1>中文清单</h1>' } },
            { type: 'tool_use', name: 'Artifact', input: { file_path: '/home/claude/checklist.html' } },
        ], attachments: [{ success: true, file_kind: 'blob', download_source: 'files-api',
            file_name: 'checklist.html', size_bytes: new TextEncoder().encode('<h1>中文清单</h1>').byteLength }] },
    ]),
    'CL_L1_SOURCE_FILE_CARD_AMBIGUOUS_01': () => detail([
        message(root, null, 'human', 'Q'),
        { ...message(leaf, root, 'assistant', ''), content: [
            { type: 'tool_use', name: 'Write', input: { file_path: '/home/claude/checklist.html', content: '<h1>中文清单</h1>' } },
            { type: 'tool_use', name: 'Artifact', input: { file_path: '/home/claude/checklist.html' } },
            { type: 'tool_use', name: 'Artifact', input: { file_path: '/tmp/checklist.html' } },
        ], files: [{ success: true, file_kind: 'blob', download_source: 'files-api',
            file_name: 'checklist.html', size_bytes: new TextEncoder().encode('<h1>中文清单</h1>').byteLength }] },
    ]),

    'CL_L1_SOURCE_WIDGETS_COMPLETE_01': () => detail([
        { ...message(leaf, null, 'assistant', ''), content: nativeWidgets() },
    ]),
    'CL_L1_SOURCE_WIDGETS_UNSUPPORTED_ENGINE_01': () => detail([
        { ...message(leaf, null, 'assistant', ''), content: [
            ...nativeWidgets(),
            { type: 'tool_use', name: 'mcp__Claude_Docs__update', input: { engine: 'unsupported' } },
        ] },
    ]),
    'CL_L1_SOURCE_GENERATED_FILE_01': () => detail([
        { ...message(leaf, null, 'assistant', 'Done'), files: [{
            success: true, file_kind: 'blob', download_source: 'files-api',
            file_uuid: '22222222-2222-4222-8222-222222222222', file_name: 'result.py', size_bytes: 8,
        }] },
    ]),
    'CL_L1_SOURCE_GENERATED_FILE_INVALID_ID_01': () => detail([
        { ...message(leaf, null, 'assistant', 'Done'), files: [{
            success: true, file_kind: 'blob', download_source: 'files-api',
            file_uuid: 'https://evil.example/file', file_name: 'result.py', size_bytes: 8,
        }] },
    ]),
    'CL_L1_SOURCE_QUOTA_ERROR_01': () => detail([
        { ...message(leaf, null, 'assistant', 'Partial code explanation'), stop_reason: 'error' },
    ]),
    'CL_L1_SOURCE_QUOTA_MAX_TOKENS_01': () => detail([
        { ...message(leaf, null, 'assistant', 'Partial code explanation'), stop_reason: 'max_tokens' },
    ]),
    'CL_L1_SOURCE_QUOTA_TOOL_USE_01': () => detail([
        { ...message(leaf, null, 'assistant', 'Partial code explanation'), stop_reason: 'tool_use' },
    ]),
    'CL_L1_SOURCE_QUOTA_USER_CANCELED_01': () => detail([
        { ...message(leaf, null, 'assistant', 'Partial code explanation'), stop_reason: 'user_canceled' },
    ]),
    'CL_L1_SOURCE_DOCS_TEMPLATE_01': () => detail([
        { ...message(leaf, null, 'assistant', ''), content: [{
            type: 'tool_use', name: 'mcp__Claude_Docs__batch', input: { batch: [], container: { create: { doc: {
                markdown: '# Report\n\n<?claude block date?>\n\n<?claude block section?>',
                blocks: { date: { type: 'date', value: '2026-10-22' },
                    section: { type: 'pending', intent: 'Explain uncertainty' } },
            } } } },
        }] },
    ]),
    'CL_L1_SOURCE_SHELL_INVALIDATES_ARTIFACT_01': () => detail([
        { ...message(leaf, null, 'assistant', ''), content: [
            { type: 'tool_use', name: 'Write', input: { file_path: '/home/claude/test.txt', content: 'old' } },
            { type: 'tool_use', name: 'Bash', input: { command: "printf new > /home/claude/test.txt" } },
            { type: 'tool_use', name: 'Artifact', input: { file_path: '/home/claude/test.txt' } },
        ] },
    ]),
    'CL_L1_SOURCE_DUPLICATE_MESSAGE_UUID_01': () => detail([
        message(leaf, null, 'assistant', 'One'),
        message(leaf, null, 'assistant', 'Two'),
    ]),

};

export function detailGen(key: keyof typeof fixtureMap) {
    return fixtureMap[key]();
}

export const fixtureOrigins = describeFixtures(fixtureMap, synthetic("Authored Claude protocol, content or state counterexample; no saved capture is used."));
