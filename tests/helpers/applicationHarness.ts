import type { ConversationKey } from '../../src/l2/conversationKey.js';
import type { Account } from '../../src/l2/accountRegistry.js';
import type { DomainConversationIndex } from '../../src/l2/conversationIndex.js';
import type { TrustedDomainBody, ReadonlyDomain } from '../../src/l2/runtimeValidation.js';
import type { Diagnostic } from '../../src/shared/diagnostics/diagnostic.js';
import type { PreparedResources } from '../../src/shared/resources/resourceResult.js';
import type { DocumentAst } from '../../src/l3b/ast/ast.js';
import type { ResourceBindings } from '../../src/l4/packaging/resourceBindings.js';
import type { ExportPathPlan, ExportFormat, ExportDelivery } from '../../src/l4/packaging/index.js';
import type { ExportRecord, ExportRequest } from '../../src/application/export/types.js';
import type { GlobalSettings } from '../../src/application/settings/index.js';
import type { AIProvider, ListFailureDiagnostics } from '../../src/l1/client/aiProvider.js';
import type { ExportArtifact } from '../../src/l4/artifacts.js';
import type { SourceResourceContext } from '../../src/l1/resources/sourceResources.js';

// Application unit-test ports. No production implementation from L1/L2/L3b/L4,
// Storage or Runtime is loaded. Real inter-module contracts belong to integration tests.
// Install before requiring an Application entry point in the test file.
export function stubModule(path: string, exports: object): void {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports } as NodeModule;
}

export const account: Account = {
    id: '10000000-0000-4000-8000-000000000001', providerId: 'gemini', providerAccountId: 'fixture',
};
export const key = (conversationId = 'first'): ConversationKey => ({ accountId: account.id, conversationId });
export const address = (key: ConversationKey): string => JSON.stringify([key.accountId, key.conversationId]);
export const indexes = new Map<string, DomainConversationIndex>();
export const details = new Map<string, TrustedDomainBody>();
export const records = new Map<string, ExportRecord>();
export const events: string[] = [];
export const deliveries: ExportArtifact[][] = [];
export const contexts: SourceResourceContext[] = [];
let settings: Partial<GlobalSettings> = {};

type RenderFormat = 'markdown' | 'html' | 'json';
type RendererCall = { format: RenderFormat; key: string; locale?: 'zh' | 'en'; bindings: ResourceBindings };
type PlanCall = { format: ExportFormat; key: string; fileIds: string[]; preparedIds: string[] };
type PackageCall = { delivery: ExportDelivery; groups: number; files: number };
export const references = new Map<string, { referencedIds: string[]; imageIds: string[]; fileIds: string[] }>();
export const state = {
    failRead: false, failSettingsRead: false, failSettingsWrite: false,
    failRecord: '', failDelivery: 0, failDelete: '', failPackage: false,
    failRender: '' as RenderFormat | '', failRenderKey: '' as string,
    directory: {} as FileSystemDirectoryHandle | null,
    existingFiles: new Set<string>(),
    onDelivery: undefined as (() => void) | undefined,
    onPackage: undefined as ((archiveName?: string) => Promise<void>) | undefined,
    sourceContext: undefined as SourceResourceContext | undefined,
    releasedKeys: [] as string[], releasedContexts: 0,
    pdfPrepared: [] as string[], pdfBindings: {} as ResourceBindings,
    pdfDiagnostics: [] as Diagnostic[], htmlDiagnostics: [] as Diagnostic[],
    pdfLocale: undefined as 'zh' | 'en' | undefined, pdfRenderKey: '' as string,
    accountOverride: undefined as Account | null | undefined, settingsReads: 0, disposed: 0,
    compositions: [] as ReadonlyDomain[],
    jsonInputs: [] as ReadonlyDomain[],
    rendererCalls: [] as RendererCall[],
    folderPlans: [] as PlanCall[], browserPlans: [] as PlanCall[],
    folderPlannerCreations: [] as ExportFormat[],
    packages: [] as PackageCall[],
    builtFiles: [] as Array<{ format: ExportFormat; content: string | Uint8Array; plan: ExportPathPlan }>,
};

export const provider: AIProvider = {
    id: 'gemini', name: 'Mock Gemini', hostPatterns: [],
    async checkReadiness() { return { ready: true }; }, matchesUrl() { return true; },
    async listConversations() { return 'source_end'; },
    async fetchConversationDetail() { events.push('refresh'); },
    async acquireResource(_key, asset) {
        events.push('acquire:' + asset.id);
        return { bytes: new Uint8Array([1, 2, 3]), mediaType: asset.mediaType };
    },
};
const defaultFetch = provider.fetchConversationDetail;
const defaultAcquire = provider.acquireResource;
const defaultList = provider.listConversations;

// Cross-owner notification and source-error ports must stay mocked under strict isolation.
const sourceErrorPort: Pick<typeof import('../../src/l1/client/sourceErrors.js'), 'ConfirmedSourceEmptyError'> = {
    ConfirmedSourceEmptyError: class extends Error {
        constructor() {
            super('SOURCE_CONVERSATION_EMPTY: Source returned empty prompts and answers');
            this.name = 'ConfirmedSourceEmptyError';
        }
    },
};
const domainChangePort: Pick<typeof import('../../src/runtime/api/domainChanges.js'), 'notifyDomainChanged'> = {
    notifyDomainChanged(_accountId) {},
};
const providerErrorPort: Pick<typeof import('../../src/l1/client/aiProvider.js'), 'ProviderListError'> = {
    ProviderListError: class extends Error {
        constructor(message: string, readonly diagnostics: ListFailureDiagnostics) {
            super(message);
            this.name = 'ProviderListError';
        }
    },
};
stubModule('../../src/l1/client/aiProvider.js', providerErrorPort);
stubModule('../../src/l1/client/sourceErrors.js', sourceErrorPort);
stubModule('../../src/runtime/api/domainChanges.js', domainChangePort);

// L2 fact reading, UUID admission and Coverage are mocked at their public ports.
// No real Domain schema validator or list-coverage algorithm executes here.
stubModule('../../src/l2/accountRegistry.js', {
    DEFAULT_ACCOUNT_KEY: 'default',
    isAccountId(value: unknown) { return value === account.id; },
});
stubModule('../../src/l2/readConversation.js', { async readConversation(conversationKey: ConversationKey) {
    if (state.failRead) throw new Error('read failed');
    const index = indexes.get(address(conversationKey));
    const detail = details.get(address(conversationKey));
    return index && detail ? { index, detail } : null;
} });

stubModule('../../src/l3a/storageService.js', {
    async getIndex(conversationKey: ConversationKey) {
        if (state.failRead) throw new Error('read failed');
        return indexes.get(address(conversationKey)) ?? null;
    },
    async getExportRecord(conversationKey: ConversationKey) {
        if (state.failRead) throw new Error('read failed');
        return records.get(address(conversationKey)) ?? null;
    },
    async putExportRecord(conversationKey: ConversationKey, record: ExportRecord) {
        events.push('record:' + conversationKey.conversationId);
        if (state.failRecord === conversationKey.conversationId) throw new Error('record failed');
        records.set(address(conversationKey), record);
    },
    async clearStoredAccountExportRecords(accountId: string) {
        events.push('clear-export:' + accountId);
        if (state.failDelete === 'record') throw new Error('delete failed');
    },
    async clearStoredAccountScanRecords(accountId: string) {
        events.push('clear-scan:' + accountId);
        if (state.failDelete === 'coverage') throw new Error('coverage failed');
    },
    async getDirectoryHandle() { return state.directory; },
    async getStoredSettings() {
        state.settingsReads++;
        if (state.failSettingsRead) throw new Error('read failed');
        return structuredClone(settings);
    },
    async patchStoredSettings(patch: Partial<GlobalSettings>) {
        if (state.failSettingsWrite) throw new Error('write failed');
        events.push('settings-write');
        settings = { ...settings, ...patch };
    },
});
stubModule('../../src/runtime/api/accountRegistry.js', { async getAccount(id: string) {
    return state.accountOverride === undefined ? { ...account, id } : state.accountOverride;
} });
stubModule('../../src/l1/client/providerRegistry.js', {
    ProviderRegistry: { get() { return provider; }, register() {} },
});
stubModule('../../src/l1/client/gemini/geminiProvider.js', { defaultGeminiProvider: provider });
stubModule('../../src/l1/resources/sourceResources.js', {
    createSourceResourceContext(): SourceResourceContext {
        const context = {
            releaseConversation(conversationKey: ConversationKey) {
                state.releasedKeys.push(conversationKey.conversationId);
            },
            release() { state.releasedContexts++; },
        } as unknown as SourceResourceContext;
        return context;
    },
});
stubModule('../../src/l1/client/taskProvider.js', {
    createTaskProvider(_providerId: string, resources: SourceResourceContext): AIProvider {
        contexts.push(resources);
        state.sourceContext = resources;
        return provider;
    },
});

// The AST is an opaque value to Application. Fixture references are supplied by
// this fake L3b port; unit tests do not verify AST composition or traversal.
type FakeDocument = DocumentAst & { fixtureId: string };
const fixtureId = (document: DocumentAst): string => (document as FakeDocument).fixtureId;
stubModule('../../src/l3b/compose/composeDomainDocument.js', {
    composeDomainDocument(conversation: ReadonlyDomain, _account: Account): DocumentAst {
        state.compositions.push(conversation);
        return { fixtureId: conversation.index.key.conversationId } as FakeDocument;
    },
});
stubModule('../../src/l3b/ast/resourceReferences.js', {
    collectDocumentResources(document: DocumentAst) {
        const source = references.get(fixtureId(document));
        return {
            referencedIds: new Set(source?.referencedIds ?? []),
            imageIds: new Set(source?.imageIds ?? []),
            fileIds: new Set(source?.fileIds ?? []),
        };
    },
});

// L4 mocks return opaque format and packaging artifacts. The assertions are about
// how Application calls L4, never L4's serialized bytes or path-naming algorithm.
function recordRender(format: RenderFormat, document: DocumentAst, bindings: ResourceBindings, locale?: 'zh' | 'en'): string {
    const id = fixtureId(document);
    if (state.failRender === format && (!state.failRenderKey || state.failRenderKey === id)) throw new Error('Mock format failed');
    state.rendererCalls.push({ format, key: id, locale, bindings });
    return 'mock-' + format + '-' + id;
}
stubModule('../../src/l4/format/markdown/renderMarkdown.js', {
    renderDocumentMarkdown(document: DocumentAst, bindings: ResourceBindings, options: { locale: 'zh' | 'en' }) {
        return recordRender('markdown', document, bindings, options.locale);
    },
});
stubModule('../../src/l4/format/html/renderHtml.js', {
    renderDocumentHtml(document: DocumentAst, bindings: ResourceBindings, options: { locale: 'zh' | 'en' }) {
        return { html: recordRender('html', document, bindings, options.locale), diagnostics: state.htmlDiagnostics };
    },
});
stubModule('../../src/l4/format/json/serializeDomainJson.js', {
    serializeDomainJson(conversation: ReadonlyDomain, _account: Account, bindings: ResourceBindings) {
        if (state.failRender === 'json' && (!state.failRenderKey || state.failRenderKey === conversation.index.key.conversationId)) {
            throw new Error('Mock format failed');
        }
        state.jsonInputs.push(conversation);
        state.rendererCalls.push({ format: 'json', key: conversation.index.key.conversationId, bindings });
        return 'mock-json-' + conversation.index.key.conversationId;
    },
});
function plan(format: ExportFormat, conversation: ReadonlyDomain, prepared: PreparedResources,
    fileIds: ReadonlySet<string>, target: PlanCall[], expectedIds?: ReadonlySet<string>): ExportPathPlan {
    const id = conversation.index.key.conversationId;
    target.push({ format, key: id, fileIds: [...fileIds], preparedIds: [...prepared.keys()] });
    const resources: Record<string, string> = {};
    for (const [assetId, value] of prepared) if (value.ok) resources[assetId] = 'mock/' + assetId;
    for (const id of expectedIds ?? []) resources[id] = 'mock/' + id;
    return { fileName: 'mock-' + id + '.' + format, resources, externalResourceIds: new Set(Object.keys(resources)) };
}
stubModule('../../src/l4/packaging/index.js', {
    createExportPathPlanner(format: ExportFormat) {
        state.folderPlannerCreations.push(format);
        return (conversation: ReadonlyDomain, prepared: PreparedResources, fileIds: ReadonlySet<string>, baseName?: string, expectedIds?: ReadonlySet<string>) => {
            const planned = plan(format, conversation, prepared, fileIds, state.folderPlans, expectedIds);
            return baseName ? { ...planned, fileName: `${baseName}.${format}` } : planned;
        };
    },
    planExportPaths(inputs: readonly { conversation: ReadonlyDomain; prepared: PreparedResources;
        fileIds: ReadonlySet<string> }[], format: ExportFormat) {
        return inputs.map(item => plan(format, item.conversation, item.prepared, item.fileIds, state.browserPlans));
    },
    buildExportFiles(format: ExportFormat, planned: ExportPathPlan,
        content: string | Uint8Array, _prepared: PreparedResources): ExportArtifact[] {
        state.builtFiles.push({ format, content, plan: planned });
        return [{ fileName: planned.fileName, mimeType: 'application/x-mock', content }];
    },
    buildResourceFiles(planned: ExportPathPlan, prepared: PreparedResources): ExportArtifact[] {
        return [...planned.externalResourceIds].map(id => {
            const value = prepared.get(id);
            if (!value?.ok) throw new Error('Unavailable bound resource');
            return { fileName: planned.resources[id], mimeType: value.value.mediaType ?? 'application/octet-stream', content: value.value.bytes };
        });
    },
    async packageExportFiles(groups: readonly (readonly ExportArtifact[])[], delivery: ExportDelivery, archiveName?: string) {
        await state.onPackage?.(archiveName);
        const files = groups.flatMap(group => [...group]);
        state.packages.push({ delivery, groups: groups.length, files: files.length });
        if (state.failPackage) throw new Error('Mock package failed');
        if (delivery === 'browserDownload' && (files.length > 1 || archiveName)) {
            return [{ fileName: archiveName ?? 'mock-batch.zip', mimeType: 'application/x-mock', content: 'mock-batch' }];
        }
        return files;
    },
});
async function deliver(files: readonly ExportArtifact[]) {
    events.push('delivery');
    deliveries.push([...files]);
    if (state.failDelivery === deliveries.length) throw new Error('delivery failed');
    state.onDelivery?.();
}
stubModule('../../src/l4/delivery/index.js', {
    folderFileExists: async (_directory: FileSystemDirectoryHandle, path: string) => state.existingFiles.has(path),
    startBrowserDownload: (file: ExportArtifact) => deliver([file]),
    writeToFolder: deliver,
});
stubModule('../../src/l4/format/pdf/compileDocumentPdf.js', {
    async compileDocumentPdf(document: DocumentAst, bindings: ResourceBindings,
        prepared: PreparedResources, _compiler: unknown, _context: unknown, options: { locale: 'zh' | 'en' }) {
        state.pdfPrepared = [...prepared.keys()];
        state.pdfBindings = bindings;
        state.pdfLocale = options.locale;
        state.pdfRenderKey = fixtureId(document);
        return { pdfBytes: new Uint8Array([37, 80, 68, 70]), diagnostics: state.pdfDiagnostics };
    },
});
stubModule('../../src/l4/format/pdf/typst/typstSandboxCompiler.js', {
    TypstSandboxCompiler: class { dispose() { state.disposed++; } },
});
stubModule('../../src/l4/format/pdf/typst/fonts/localFontProvider.js', { async resolveLocalFonts() { return {}; } });
stubModule('../../src/l4/format/pdf/typst/fonts/mountRuntimeFonts.js', {
    async mountRuntimeFonts() { return { effectiveFonts: { diagnostics: [] } }; },
});

export function seed(id = 'first', options: {
    updatedAt?: number; savedAt?: number; quality?: 'complete' | 'partial' | 'unknown'; assets?: boolean;
} = {}) {
    const conversationKey = key(id);
    const index: DomainConversationIndex = {
        key: conversationKey, title: 'Title ' + id, titleSource: 'provider',
        updatedAt: options.updatedAt ?? 100,
    };
    // TrustedDomainBody is an incoming L2 contract in this unit fixture. L2 validation
    // and brand production are tested in L2, not simulated by calling L2 here.
    const detail = {
        key: conversationKey, savedAt: options.savedAt ?? 100,
        quality: { status: options.quality ?? 'complete' },
        messages: [{
            role: 'user', content: [
                { type: 'paragraph', children: [{ type: 'text', text: 'Body ' + id }] },
                ...(options.assets ? [{ type: 'image', assetId: 'image' }, { type: 'file', assetId: 'file' }] : []),
            ],
        }],
        assets: options.assets ? [
            { id: 'image', kind: 'image', mediaType: 'image/png', sourceUri: 'https://example.com/image.png' },
            { id: 'file', kind: 'file', sourceUri: 'https://example.com/file.txt' },
            { id: 'unused', kind: 'file', sourceUri: 'https://example.com/unused.txt' },
        ] : [],
    } as unknown as TrustedDomainBody;
    indexes.set(address(conversationKey), index);
    details.set(address(conversationKey), detail);
    references.set(id, options.assets
        ? { referencedIds: ['image', 'file'], imageIds: ['image'], fileIds: ['file'] }
        : { referencedIds: [], imageIds: [], fileIds: [] });
    return { index, detail };
}
export function request(patch: Partial<ExportRequest> = {}): ExportRequest {
    return { keys: [key()], format: 'markdown', delivery: 'browserDownload',
        includeAssets: true, skipUnchanged: false, ...patch };
}
export function reset(): void {
    // Production Export runs in Chrome; model its browser language in this Node-only harness.
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en-US' } });
    indexes.clear(); details.clear(); records.clear(); references.clear();
    events.length = 0; deliveries.length = 0; contexts.length = 0; settings = {};
    Object.assign(state, {
        failRead: false, failSettingsRead: false, failSettingsWrite: false,
        failRecord: '', failDelivery: 0, failDelete: '', failPackage: false, failRender: '', failRenderKey: '',
        existingFiles: new Set<string>(), directory: {}, onDelivery: undefined, onPackage: undefined, sourceContext: undefined,
        releasedKeys: [], releasedContexts: 0,
        pdfPrepared: [], pdfBindings: {}, pdfDiagnostics: [], htmlDiagnostics: [],
        pdfLocale: undefined, pdfRenderKey: '', accountOverride: undefined, settingsReads: 0, disposed: 0,
        compositions: [], jsonInputs: [], rendererCalls: [], folderPlans: [], browserPlans: [],
        folderPlannerCreations: [], packages: [], builtFiles: [],
    });
    Object.assign(provider, {
        fetchConversationDetail: defaultFetch, acquireResource: defaultAcquire,
        listConversations: defaultList,
    });
}
