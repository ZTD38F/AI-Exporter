import { OperationError, operationIssue, operationError } from '../../shared/errors/operationError.js';
import { ConfirmedSourceEmptyError } from '../../l1/client/sourceErrors.js';
import { readConversation } from '../../l2/readConversation.js';
import { getSettings } from '../settings/index.js';
import { getAccount } from '../../runtime/api/accountRegistry.js';
import { getIndex, getExportRecord, putExportRecord, getDirectoryHandle } from '../../l3a/storageService.js';
import type { ConversationKey } from '../../l2/conversationKey.js';
import type { Account } from '../../l2/accountRegistry.js';
import { type ReadonlyDomain } from '../../l2/runtimeValidation.js';
import type { AIProvider } from '../../l1/client/aiProvider.js';
import { createTaskProvider } from '../../l1/client/taskProvider.js';
import { createSourceResourceContext } from '../../l1/resources/sourceResources.js';
import { composeDomainDocument } from '../../l3b/compose/composeDomainDocument.js';
import { collectDocumentResources } from '../../l3b/ast/resourceReferences.js';
import type { DocumentAst } from '../../l3b/ast/ast.js';
import { missingResource, resourceIssueKind, type ResourceFailure } from '../../shared/resources/resourceResult.js';
import type { PreparedResources, ResourceResult } from '../../shared/resources/resourceResult.js';
import { renderDocumentMarkdown } from '../../l4/format/markdown/renderMarkdown.js';
import { renderDocumentHtml } from '../../l4/format/html/renderHtml.js';
import { renderDocumentDocx } from '../../l4/format/docx/renderDocx.js';
import { serializeDomainJson } from '../../l4/format/json/serializeDomainJson.js';
import { createExportPathPlanner, planExportPaths, buildExportFiles, buildResourceFiles, packageExportFiles, type ExportPathPlan } from '../../l4/packaging/index.js';
import type { ExportArtifact } from '../../l4/artifacts.js';
import { startBrowserDownload, writeToFolder, folderFileExists } from '../../l4/delivery/index.js';
import { compileDocumentPdf } from '../../l4/format/pdf/compileDocumentPdf.js';
import { TypstSandboxCompiler } from '../../l4/format/pdf/typst/typstSandboxCompiler.js';
import { resolveLocalFonts } from '../../l4/format/pdf/typst/fonts/localFontProvider.js';
import { mountRuntimeFonts } from '../../l4/format/pdf/typst/fonts/mountRuntimeFonts.js';
import { prepareExportResources } from './prepareExportResources.js';
import type { ExportRequest, ExportRecord, ExportProgress, ExportResult, ExportItemUpdate, ExportDiagnostic } from './types.js';

// Domain and ExportRecord source versions must be finite, safe epoch-millisecond integers.
const comparable = (value: number | undefined): value is number => value !== undefined && Number.isSafeInteger(value);
export function shouldSkipExport(record: ExportRecord | null, updatedAt: number | undefined, request: ExportRequest): boolean {
    if (!request.skipUnchanged || !record || record.format !== request.format) return false;
    if (record.sourceTurn && record.sourceTurn !== 'finished' && record.sourceTurn !== 'interrupted') return false;
    const issues = record.attachmentIssues;
    const expiredOnly = record.status === 'partial' && record.otherContentMissing !== true
        && issues !== undefined && issues.length > 0
        && issues.every(issue => resourceIssueKind(issue) === 'expired' && issue.httpStatus === 404);
    return (record.status === 'ok' || expiredOnly) && comparable(record.chatTime)
        && comparable(updatedAt) && record.chatTime >= updatedAt;
}
function isFresh(conversation: ReadonlyDomain): boolean {
    return conversation.detail.quality.status === 'complete'
        && (!conversation.detail.quality.sourceTurn || ['finished', 'interrupted'].includes(conversation.detail.quality.sourceTurn))
        && comparable(conversation.detail.savedAt)
        && comparable(conversation.index.updatedAt) && conversation.detail.savedAt >= conversation.index.updatedAt;
}
type PendingContent = { format: 'json'; document?: never }
    | { format: Exclude<ExportRequest['format'], 'json'>; document: DocumentAst };
type ExportSource = PendingContent & {
    key: ConversationKey;
    account: Account;
    conversation: ReadonlyDomain;
    requiredIds: ReadonlySet<string>;
    refreshFailed: boolean;
    fileIds: ReadonlySet<string>;
    folderBaseName?: string;
}
type PendingExport = ExportSource & { prepared: PreparedResources; reused: ReadonlySet<string> };
interface ExportGroup { key: ConversationKey; record: Omit<ExportRecord, 'exportedAt'>; files: ExportArtifact[] }

/** One task owns independent source/resource acquisition, final delivery and records. */
export async function runExport(request: ExportRequest, options: {
    onProgress?: (progress: ExportProgress) => void;
    /** A usable body is ready for resource preparation; skipped targets do not count. */
    onConversationPrepared?: (key: ConversationKey) => void;
    /** A document has reached its destination; browser delivery includes its attachments. */
    onBodyDelivered?: (key: ConversationKey) => void;
    /** downloaded counts distinct successful resource identities across this task, including refreshes. */
    onResourceProgress?: (progress: { key: ConversationKey; completed: number; total: number; downloaded: number }) => void;
    /** Settled items and staged browser files; only 'exported' carries a committed record. */
    onItemUpdate?: (update: ExportItemUpdate) => void;
    onDiagnostic?: (diagnostic: ExportDiagnostic) => void;
    signal?: AbortSignal;
    /** A completed reply requires a new source snapshot even if cached timestamps match. */
    refreshDetail?: boolean;
    /** User-selected ZIP readers owned by the open workbench, released by that page. */
    importedResources?: import('../../l1/resources/sourceResources.js').SourceResourceContext;
} = {}): Promise<ExportResult> {
    const failed: ConversationKey[] = [];
    const result: ExportResult = { exported: 0, skipped: 0, partial: 0, failed, aborted: false };
    const controller = new AbortController();
    const signal = controller.signal;
    const cancel = (): void => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) cancel();
    else options.signal?.addEventListener('abort', cancel, { once: true });
    // Attachment work has its own bounded pool; it never gates the next source read.
    let downstream = Promise.resolve();
    let saveCancelledFiles: (() => Promise<void>) | undefined;
    const queued = new Map<string, Promise<void>>();
    const deliveredBodies = new Set<string>();
    const identity = (key: ConversationKey) => JSON.stringify([key.accountId, key.conversationId]);
    const resources = createSourceResourceContext();
    const providers = new Map<string, AIProvider>();
    const downloadedResources = new Set<string>();
    let compiler: import('../../l4/format/pdf/typst/typstSandboxCompiler.js').TypstSandboxCompiler | undefined;
    let locale: 'zh' | 'en' = 'en';
    let fontDiagnostics: readonly import('../../shared/diagnostics/diagnostic.js').Diagnostic[] = [];
    const cancelled = (error: unknown): boolean => signal.aborted || (error instanceof Error && error.name === 'AbortError');
    const report = (update: ExportItemUpdate): void => {
        try { options.onItemUpdate?.(update); }
        catch (error) { console.warn('[Gemini Exporter] Export progress listener failed', error); }
    };
    const diagnose = (diagnostic: ExportDiagnostic): void => {
        if (diagnostic.code === 'CHATGPT_RATE_LIMITED' || diagnostic.code === 'CHATGPT_COOLDOWN_ACTIVE') {
            const details = diagnostic.details;
            if (details && typeof details === 'object' && !Array.isArray(details)) {
                const data = details.observation ?? details;
                if (data && typeof data === 'object' && !Array.isArray(data) && typeof data.retryAt === 'number') {
                    result.rateLimitedUntil = Math.max(result.rateLimitedUntil ?? 0, data.retryAt);
                    controller.abort();
                }
            }
        }
        try { options.onDiagnostic?.(diagnostic); }
        catch (error) { console.warn('[Gemini Exporter] Export diagnostic listener failed', error); }
    };
    const bodyDelivered = (key: ConversationKey): void => {
        if (deliveredBodies.has(identity(key))) return;
        deliveredBodies.add(identity(key));
        diagnose({ key, stage: 'delivery', code: 'DOCUMENT_DELIVERED', severity: 'info', message: 'Document delivery initiated' });
        try { options.onBodyDelivered?.(key); }
        catch (error) { console.warn('[Gemini Exporter] Body delivery listener failed', error); }
    };
    const fail = (keys: readonly ConversationKey[], _error?: unknown): void => {
        const issue = operationIssue(_error);
        for (const key of keys) {
            const diagnostic: ExportDiagnostic = { key, stage: 'export', code: 'EXPORT_FAILED', severity: 'error', issue,
                message: issue.message };
            diagnose(diagnostic);
            if (!failed.some(item => item.accountId === key.accountId && item.conversationId === key.conversationId)) {
                failed.push(key);
                report({ key, status: 'failed', diagnostic });
            }
        }
    };
    const providerFor = (id: string): AIProvider => {
        let provider = providers.get(id);
        if (!provider) {
            provider = createTaskProvider(id, resources);
            providers.set(id, provider);
        }
        return provider;
    };
    const readLocal = readConversation;
    const finalize = async (groups: readonly ExportGroup[]): Promise<void> => {
        // Once Delivery returned, cancellation cannot suppress records for that group/ZIP.
        const exportedAt = Date.now();
        for (const group of groups) {
            bodyDelivered(group.key);
            try {
                const record: ExportRecord = { ...group.record, exportedAt };
                await putExportRecord(group.key, record);
                result.exported++;
                if (group.record.status === 'partial') { result.partial++; result.otherPartial ??= 0; }
                if (group.record.attachmentIssues?.length) result.attachmentIssues = [...(result.attachmentIssues ?? []), ...group.record.attachmentIssues];
                if (group.record.attachmentIssues?.some(issue => resourceIssueKind(issue) === 'expired')) result.expiredConversations = (result.expiredConversations ?? 0) + 1;
                if (group.record.status === 'partial' && (!group.record.attachmentIssues?.length
                    || group.record.otherContentMissing)) result.otherPartial = (result.otherPartial ?? 0) + 1;
                report({ key: group.key, status: 'exported', record });
            } catch (error) {
                console.warn('[Gemini Exporter] ExportRecord write failed', group.key, error);
                fail([group.key], operationError(error, 'RECORD_WRITE_FAILED'));
            }
        }
    };
    const recordFor = (item: PendingExport, plan: ExportPathPlan,
        failures: Readonly<Record<string, ResourceFailure>>, otherContentMissing: boolean): Omit<ExportRecord, 'exportedAt'> => {
        const { conversation } = item;
        const partial = otherContentMissing || Object.keys(failures).length > 0;
        return { format: request.format, status: partial ? 'partial' : 'ok',
            ...(request.delivery === 'folderWriter'
                ? { folderBaseName: plan.fileName.replace(/\.[^.]+$/, '') }
                : item.folderBaseName ? { folderBaseName: item.folderBaseName } : {}),
            ...(conversation.detail.quality.sourceTurn ? { sourceTurn: conversation.detail.quality.sourceTurn } : {}),
            ...(partial ? { otherContentMissing } : {}),
            ...(Object.keys(failures).length ? { attachmentIssues: Object.values(failures).map(failure => {
                const asset = conversation.detail.assets.find(asset => asset.id === failure.resourceId);
                const sourceUri = asset?.sourceUri;
                return { resourceId: failure.resourceId, name: asset?.name || failure.resourceId, code: failure.code,
                    ...(failure.httpStatus ? { httpStatus: failure.httpStatus } : {}),
                    ...(sourceUri && /^https:\/\//i.test(sourceUri) ? { sourceUrl: sourceUri } : {}) };
            }) } : {}),
            ...(comparable(conversation.detail.savedAt) ? { chatTime: conversation.detail.savedAt } : {}) };
    };
    const renderGroup = async (item: PendingExport, plan: ExportPathPlan): Promise<ExportGroup> => {
        const { conversation, document, prepared, key, format } = item;
        // Index activity may advance without new body bytes. Keep timestamp disagreement
        // as a freshness diagnostic; it does not establish missing snapshot content.
        let otherContentMissing = item.refreshFailed || conversation.detail.quality.status !== 'complete';
        const sourceTurn = conversation.detail.quality.sourceTurn;
        if (sourceTurn && sourceTurn !== 'finished') diagnose({ key, stage: 'detail', severity: 'info',
            code: 'SOURCE_TURN_' + sourceTurn.toUpperCase(),
            message: 'Available source content is exported independently of source turn completion',
            details: { sourceTurn, snapshotCoverage: conversation.detail.quality.status } });
        if (conversation.detail.quality.status !== 'complete') diagnose({ key, stage: 'detail',
            severity: 'warning', code: 'DETAIL_NOT_COMPLETE', message: 'Persisted source detail is not complete',
            details: { quality: conversation.detail.quality.status, messageCount: conversation.detail.messages.length,
                savedAt: conversation.detail.savedAt ?? null, indexUpdatedAt: conversation.index.updatedAt ?? null,
                lastMessageId: conversation.detail.messages.at(-1)?.id ?? null,
                lastMessageRole: conversation.detail.messages.at(-1)?.role ?? null } });
        if (comparable(conversation.detail.savedAt) && comparable(conversation.index.updatedAt)
            && conversation.detail.savedAt < conversation.index.updatedAt) diagnose({ key, stage: 'detail',
            severity: 'warning', code: 'DETAIL_STALE', message: 'Detail source timestamp is older than Index',
            details: { savedAt: conversation.detail.savedAt, updatedAt: conversation.index.updatedAt,
                lagMs: conversation.index.updatedAt - conversation.detail.savedAt } });
        const failures = Object.fromEntries([...prepared].filter((entry): entry is [string, ResourceFailure] => !entry[1].ok));
        for (const failure of Object.values(failures)) diagnose({ key, stage: 'resource', severity: 'warning',
            code: failure.code, message: failure.reason, issue: failure.issue,
            details: { resourceId: failure.resourceId, httpStatus: failure.httpStatus ?? null } });
        const renderOptions = { locale, resourceFailures: failures };
        let content: string | Uint8Array;
        switch (format) {
            case 'json': content = serializeDomainJson(conversation, item.account, plan.resources); break;
            case 'markdown': content = renderDocumentMarkdown(document, plan.resources, renderOptions); break;
            case 'docx': {
                content = await renderDocumentDocx(document, plan.resources, prepared, renderOptions);
                break;
            }
            case 'html': {
                const html = renderDocumentHtml(document, plan.resources, renderOptions);
                for (const diagnostic of html.diagnostics) diagnose({ key, stage: 'html', ...diagnostic });
                content = html.html;
                otherContentMissing ||= html.diagnostics.some(diagnostic => diagnostic.code === 'FORMAT_CONTENT_OMITTED');
                break;
            }
            case 'pdf': {
                if (!compiler) {
                    compiler = new TypstSandboxCompiler();
                    fontDiagnostics = (await mountRuntimeFonts(await resolveLocalFonts(), compiler)).effectiveFonts.diagnostics;
                }
                for (const diagnostic of fontDiagnostics) diagnose({ key, stage: 'pdf', ...diagnostic });
                const pdf = await compileDocumentPdf(document, plan.resources, prepared, compiler,
                    { signal, reportProgress() {} }, renderOptions);
                content = pdf.pdfBytes;
                for (const diagnostic of pdf.diagnostics) {
                    diagnose({ key, stage: 'pdf', ...diagnostic });
                    if (diagnostic.code === 'FORMAT_CONTENT_OMITTED' && diagnostic.path?.startsWith('asset:')) {
                        const id = diagnostic.path.slice(6);
                        failures[id] = missingResource(id, diagnostic.message, 'RESOURCE_PROCESSING_FAILED');
                    }
                }
                otherContentMissing ||= pdf.diagnostics.some(diagnostic => diagnostic.code === 'FORMAT_CONTENT_OMITTED' && !diagnostic.path?.startsWith('asset:'));
                break;
            }
        }
        signal.throwIfAborted();
        return { key, files: buildExportFiles(request.format, plan, content, prepared),
            record: recordFor(item, plan, failures, otherContentMissing) };
    };
    try {
        signal.throwIfAborted();
        // The user setting controls only renderer-owned text, not Domain, JSON, paths or records.
        const language = request.format === 'json' ? undefined : (await getSettings()).language;
        locale = language ?? (navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en');
        const directory = request.delivery === 'folderWriter' ? await getDirectoryHandle() : null;
        if (request.delivery === 'folderWriter' && !directory) throw new OperationError('DIRECTORY_UNAVAILABLE', 'Export directory unavailable');
        const linked = request.format === 'markdown' || request.format === 'html' || request.format === 'json';
        const folderPlanner = !linked && directory ? createExportPathPlanner(request.format) : undefined;
        const resourceScope = crypto.randomUUID();
        const linkedPlanner = linked ? createExportPathPlanner(request.format, directory ? undefined : resourceScope) : undefined;
        const bodies: { group: ExportGroup; hasAttachments: boolean }[] = [];
        const settledBodies = new Map<ExportGroup, ExportGroup>();
        const deliver = async (groups: readonly ExportGroup[], archiveName?: string, savingCancelled = false): Promise<void> => {
            if (!groups.length) return;
            let files: ExportArtifact[];
            try { files = await packageExportFiles(groups.map(group => group.files), request.delivery, archiveName); }
            catch (error) { throw operationError(error, 'PACKAGING_FAILED'); }
            if (!savingCancelled) signal.throwIfAborted();
            if (request.delivery === 'browserDownload') {
                if (files.length !== 1) throw new Error('Browser delivery requires one final file');
                await startBrowserDownload(files[0]);
            } else {
                if (!directory) throw new OperationError('DIRECTORY_UNAVAILABLE', 'Export directory unavailable');
                await writeToFolder(files, directory);
            }
        };
        const deliverBrowserBodies = async (savingCancelled = false): Promise<void> => {
            const staged = bodies.filter(({group}) => !deliveredBodies.has(identity(group.key))
                && !failed.some(key => identity(key) === identity(group.key)));
            const groups = staged.map(({group}) => {
                const settled = settledBodies.get(group);
                // Resource refresh can replace the rendered document at its original path.
                const files = new Map([...group.files, ...(settled?.files ?? [])].map(file => [file.fileName, file]));
                return { ...group, record: settled?.record ?? group.record, files: [...files.values()] };
            });
            try {
                await deliver(groups, undefined, savingCancelled);
                for (const group of groups) bodyDelivered(group.key);
                await finalize(groups.filter((_, index) => !staged[index].hasAttachments || settledBodies.has(staged[index].group)));
            } catch (error) {
                if (cancelled(error) && !savingCancelled) throw error;
                fail(groups.map(group => group.key), error);
            }
        };
        if (linked && !directory) saveCancelledFiles = async () => {
            // Acquisition stops first; one ZIP preserves completed attachments and all
            // rendered bodies. Unfinished items never receive a successful record.
            await downstream;
            await deliverBrowserBodies(true);
        };
        const pending: PendingExport[] = [];
        for (const [index, key] of request.keys.entries()) {
            // Duplicate keys share task-owned readers; finish their earlier use first.
            const previous = queued.get(identity(key));
            if (previous) await previous;
            signal.throwIfAborted();
            options.onProgress?.({ current: index + 1, total: request.keys.length, key });
            let handedOff = false;
            try {
                // These local facts are independent; don't serialize three storage round trips.
                const [account, localIndex, record] = await Promise.all([
                    getAccount(key.accountId), getIndex(key),
                    getExportRecord(key),
                ]);
                if (!account) throw new OperationError('ACCOUNT_UNAVAILABLE', 'Account unavailable');
                if (!options.refreshDetail && localIndex && shouldSkipExport(record, localIndex.updatedAt, request)) {
                    result.skipped++;
                    report({ key, status: 'skipped' });
                    continue;
                }
                let conversation = await readLocal(key);
                let refreshFailed = false;
                let refreshFailure: { error: unknown } | undefined;
                // Inline packets and expiring locators are task-owned, never cached bytes.
                // A fresh Detail alone cannot rehydrate these resources in a later export.
                const needsSourceReaders = request.includeAssets && conversation?.detail.assets.some(asset =>
                    !options.importedResources?.has(key, asset.id) && !/^https:\/\//i.test(asset.sourceUri ?? '') && !asset.document?.contentMarkdown
                    && providerFor(account.providerId).canAcquireResourceDirectly?.(asset) !== true);
                if (options.refreshDetail || !conversation || !isFresh(conversation) || needsSourceReaders) {
                    const before = conversation;
                    try { await providerFor(account.providerId).fetchConversationDetail(key.accountId, key.conversationId, signal,
                            diagnostic => diagnose({ key, stage: 'source_parse', ...diagnostic })); }
                    catch (error) {
                        // L1 has reliably confirmed deletion and L2 has removed the local Key.
                        // Unlike a transient refresh failure, this must never fall back to old Detail.
                        if (cancelled(error) || (error instanceof Error && error.message === 'conversation_not_found')) throw error;
                        if (error instanceof ConfirmedSourceEmptyError) {
                            result.skipped++;
                            diagnose({ key, stage: 'source_refresh', code: 'SOURCE_CONVERSATION_EMPTY', message: error.message });
                            report({ key, status: 'skipped' });
                            continue;
                        }
                        refreshFailed = true;
                        refreshFailure = { error };
                    }
                    // Even a failed refresh may have committed useful facts. Never export a response DTO.
                    conversation = await readLocal(key);
                    diagnose({ key, stage: 'source_refresh', severity: 'info', code: 'DETAIL_REFRESH_RESULT',
                        message: 'Persisted detail observed after source refresh', details: {
                            refreshFailed, requestedExplicitly: options.refreshDetail ?? false, needsSourceReaders: needsSourceReaders ?? false,
                            before: { savedAt: before?.detail.savedAt ?? null, indexUpdatedAt: before?.index.updatedAt ?? null,
                                quality: before?.detail.quality.status ?? null, messageCount: before?.detail.messages.length ?? null },
                            after: { savedAt: conversation?.detail.savedAt ?? null, indexUpdatedAt: conversation?.index.updatedAt ?? null,
                                quality: conversation?.detail.quality.status ?? null, messageCount: conversation?.detail.messages.length ?? null },
                        } });
                    if (conversation && refreshFailure) {
                        const issue = operationIssue(refreshFailure.error);
                        diagnose({ key, stage: 'source_refresh', severity: 'warning', code: 'SOURCE_REFRESH_FAILED', issue, message: issue.message });
                    }
                }
                signal.throwIfAborted();
                if (!conversation) {
                    if (refreshFailure) throw refreshFailure.error;
                    throw new OperationError('DETAIL_UNAVAILABLE', 'No usable local Detail');
                }
                const describeSource = (snapshot: ReadonlyDomain): ExportSource => {
                    const view: PendingContent = request.format === 'json' ? { format: 'json' }
                        : { format: request.format, document: composeDomainDocument(snapshot, account) };
                    const references = view.format === 'json'
                        ? { referencedIds: new Set(snapshot.detail.assets.map(asset => asset.id)), fileIds: new Set<string>() }
                        : collectDocumentResources(view.document);
                    return { ...view, key, account, conversation: snapshot, refreshFailed,
                        requiredIds: request.includeAssets ? references.referencedIds : new Set<string>(),
                        fileIds: references.fileIds,
                        ...(record?.folderBaseName ? { folderBaseName: record.folderBaseName } : {}) };
                };
                const source = describeSource(conversation);
                options.onConversationPrepared?.(key);
                const prepare = async (source: ExportSource, plan: ExportPathPlan | undefined, previous?: PreparedResources): Promise<PendingExport> => {
                    const reused = new Set<string>();
                    if (directory && plan) {
                        const checks = [...source.requiredIds].flatMap(id => {
                            const path = plan.resources[id];
                            return path ? [{ id, path }] : [];
                        });
                        const remaining = checks.values();
                        let stopped = false;
                        const checkExisting = async (): Promise<void> => {
                            try {
                                for (const { id, path } of remaining) {
                                    if (stopped) return;
                                    signal.throwIfAborted();
                                    if (await folderFileExists(directory, path)) reused.add(id);
                                }
                            } catch (error) {
                                stopped = true;
                                throw error;
                            }
                        };
                        // Independent read-only folder probes must not serialize every attachment.
                        const settled = await Promise.allSettled(Array.from({ length: Math.min(4, checks.length) }, checkExisting));
                        for (const outcome of settled) if (outcome.status === 'rejected') throw outcome.reason;
                    }
                    // A refresh retries failed identities only; successful bytes remain task-owned.
                    const requiredIds = new Set([...source.requiredIds].filter(id => !reused.has(id) && !previous?.get(id)?.ok));
                    const acquired = await prepareExportResources(source.conversation.detail.assets, requiredIds,
                        (asset, abort) => {
                            const observe = (diagnostic: import('../../shared/diagnostics/diagnostic.js').Diagnostic) => diagnose({
                                key, stage: 'resource', ...diagnostic,
                                details: { resourceId: asset.id, providerId: account.providerId, observation: diagnostic.details ?? null },
                            });
                            return options.importedResources?.has(key, asset.id)
                                ? options.importedResources.acquire(key, asset, abort,
                                    () => providerFor(account.providerId).acquireResource(key, asset, abort, observe), observe)
                                : providerFor(account.providerId).acquireResource(key, asset, abort, observe);
                        }, signal, (completed, total, result) => {
                            if (result?.ok) downloadedResources.add(JSON.stringify([key.accountId, key.conversationId, result.resourceId]));
                            options.onResourceProgress?.({ key, completed: completed + reused.size, total: total + reused.size, downloaded: downloadedResources.size });
                            diagnose({ key, stage: 'resource', severity: 'info', code: 'RESOURCE_ACQUISITION_PROGRESS',
                                message: `Attachments ${completed}/${total}`, details: { completed, total, downloaded: downloadedResources.size } });
                        });
                    const prepared = new Map<string, ResourceResult>();
                    for (const id of source.requiredIds) {
                        const value = acquired.get(id) ?? previous?.get(id);
                        if (value && !reused.has(id)) prepared.set(id, value);
                    }
                    return { ...source, prepared, reused };
                };
                const plan = linkedPlanner?.(conversation, new Map(), source.fileIds, source.folderBaseName, source.requiredIds, directory ? account : undefined);
                const body = plan ? await renderGroup({ ...source, prepared: new Map(), reused: new Set() },
                    { ...plan, externalResourceIds: new Set() }) : undefined;
                if (body) {
                    if (directory) {
                        await writeToFolder(body.files, directory);
                        bodyDelivered(key);
                        if (!source.requiredIds.size) await finalize([body]);
                    } else {
                        bodies.push({ group: body, hasAttachments: source.requiredIds.size > 0 });
                        report({ key, status: 'prepared' });
                    }
                    if (!source.requiredIds.size) continue;
                }
                downstream = downstream.then(async () => {
                    signal.throwIfAborted();
                    let item = await prepare(source, plan);
                    let finalPlan = plan;
                    let sourceChanged = false;
                    // Body timestamps do not establish whether signed resource URLs remain usable.
                    // Refresh once on an actual access/expiry response, then rebuild references from
                    // committed facts: a new source URI may also change the resource's identity.
                    if ([...item.prepared.values()].some(value => !value.ok
                        && value.code !== 'RESOURCE_LOCATOR_UNAVAILABLE'
                        && value.httpStatus !== undefined && [401, 403, 404, 410].includes(value.httpStatus))) {
                        diagnose({ key, stage: 'resource_refresh', severity: 'info', code: 'RESOURCE_REFRESH_STARTED',
                            message: 'Refreshing source after attachment access failure' });
                        let refreshed = false;
                        try {
                            await providerFor(account.providerId).fetchConversationDetail(key.accountId, key.conversationId, signal,
                                diagnostic => diagnose({ key, stage: 'source_parse', ...diagnostic }));
                            refreshed = true;
                        } catch (error) {
                            if (cancelled(error) || (error instanceof Error && error.message === 'conversation_not_found')) throw error;
                            diagnose({ key, stage: 'resource_refresh', severity: 'warning', code: 'RESOURCE_REFRESH_FAILED', issue: operationIssue(error),
                                message: error instanceof Error ? error.message : String(error) });
                            // Cached body freshness is unchanged; retain the original attachment failures.
                        }
                        signal.throwIfAborted();
                        if (refreshed) {
                            const refreshedConversation = await readLocal(key);
                            if (!refreshedConversation) throw new OperationError('DETAIL_UNAVAILABLE', 'No usable local Detail after resource refresh');
                            refreshFailed = false;
                            const refreshedSource = describeSource(refreshedConversation);
                            const initial = item.prepared;

                            if (body && plan && linkedPlanner
                                && JSON.stringify(source.conversation) !== JSON.stringify(refreshedConversation)) {
                                // A changed source can introduce new resource identities. Replace
                                // the document at its reserved path in the final ZIP or folder.
                                const revised = linkedPlanner(refreshedConversation, new Map(), refreshedSource.fileIds,
                                    refreshedSource.folderBaseName, refreshedSource.requiredIds, directory ? account : undefined);
                                finalPlan = { ...revised, fileName: plan.fileName,
                                    resources: Object.fromEntries(Object.entries(revised.resources).map(([id,path]) =>
                                        [id, plan.resources[id] ?? path])) };
                                sourceChanged = true;
                            }
                            item = await prepare(refreshedSource, finalPlan, initial);
                        }
                    }
                    const { prepared, fileIds } = item;
                    if (body && finalPlan) {
                        const failures = Object.fromEntries([...prepared].filter((entry): entry is [string, ResourceFailure] => !entry[1].ok));
                        // Replace staged body links with known failure placeholders before
                        // browser delivery, or update the already written folder document.
                        const correction = sourceChanged || Object.keys(failures).length
                            ? await renderGroup(item, { ...finalPlan,
                                resources: Object.fromEntries(Object.entries(finalPlan.resources).filter(([id]) => prepared.get(id)?.ok || item.reused.has(id))),
                                externalResourceIds: new Set() }) : undefined;
                        const record = correction?.record ?? recordFor(item, finalPlan, failures, body.record.otherContentMissing ?? false);
                        const availablePlan = { ...finalPlan, externalResourceIds: new Set([...finalPlan.externalResourceIds]
                            .filter(id => prepared.get(id)?.ok)) };
                        const files = [...(correction?.files ?? []), ...buildResourceFiles(availablePlan, prepared)];
                        if (record.attachmentIssues?.length) files.push({
                            fileName: `attachment-reports/${resourceScope}/${finalPlan.fileName}/report.json`, mimeType: 'application/json',
                            content: JSON.stringify({ document: finalPlan.fileName, conversationId: key.conversationId,
                                failures: record.attachmentIssues.map(issue => ({ ...issue, path: finalPlan.resources[issue.resourceId] })) }, null, 2),
                        });
                        const group: ExportGroup = { key, record, files };
                        if (directory) {
                            if (files.length) await writeToFolder(files, directory);
                            await finalize([group]);
                        } else settledBodies.set(body, group);
                    } else if (folderPlanner && directory) {
                        const group = await renderGroup(item, folderPlanner(item.conversation, prepared, fileIds, item.folderBaseName));
                        await writeToFolder(group.files, directory);
                        await finalize([group]);
                    } else pending.push(item);
                }).catch(error => {
                    if (cancelled(error)) controller.abort(error);
                    else {
                        console.warn('[Gemini Exporter] Export item failed', key, error);
                        fail([key], error);
                    }
                }).finally(() => {
                    resources.releaseConversation(key);
                    queued.delete(identity(key));
                });
                handedOff = true;
                queued.set(identity(key), downstream);
            } catch (error) {
                if (cancelled(error)) throw error;
                console.warn('[Gemini Exporter] Export item failed', key, error);
                fail([key], error);
            } finally {
                if (!handedOff) resources.releaseConversation(key);
            }
        }
        await downstream;
        signal.throwIfAborted();
        if (linked) {
            if (!directory) await deliverBrowserBodies();
            result.aborted = signal.aborted;
            return result;
        }
        let plans: readonly ExportPathPlan[];
        try {
            plans = folderPlanner ? [] : planExportPaths(pending, request.format);
        } catch (error) {
            if (cancelled(error)) throw error;
            console.warn('[Gemini Exporter] Export path planning failed', error);
            fail(pending.map(item => item.key), operationError(error, 'PACKAGING_FAILED'));
            return result;
        }
        const groups: ExportGroup[] = [];
        for (const [index, item] of pending.entries()) {
            signal.throwIfAborted();
            try {
                const group = await renderGroup(item, plans[index]);
                groups.push(group);
                // Browser batches are staged only. Do not mark success until the final download is initiated.
                report({ key: group.key, status: 'prepared' });
            } catch (error) {
                if (cancelled(error)) throw error;
                console.warn('[Gemini Exporter] Export format or delivery failed', item.key, error);
                fail([item.key], error);
            }
        }
        signal.throwIfAborted();
        if (groups.length) {
            try {
                await deliver(groups);
                await finalize(groups);
            } catch (error) {
                if (cancelled(error)) throw error;
                console.warn('[Gemini Exporter] Batch delivery failed', error);
                fail(groups.map(group => group.key), error);
            }
        }
        result.aborted = signal.aborted;
        return result;
    } catch (error) {
        diagnose({ stage: 'run', code: cancelled(error) ? 'EXPORT_CANCELLED' : 'EXPORT_RUN_FAILED',
            severity: cancelled(error) ? 'info' : 'error', issue: operationIssue(error),
            message: error instanceof Error ? error.message : String(error) });
        if (!cancelled(error)) throw error;
        controller.abort(error);
        await saveCancelledFiles?.();
        result.aborted = true;
        return result;
    } finally {
        controller.abort();
        await downstream;
        options.signal?.removeEventListener('abort', cancel);
        resources.release();
        compiler?.dispose();
    }
}
