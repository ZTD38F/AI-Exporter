import { runExport, type UIExportRequest } from './exportController.js';
import type { ExportDiagnostic, ExportItemUpdate, ExportResult } from '../../../application/export/types.js';
import type { ConversationKey } from '../../../l2/conversationKey.js';
import type { SourceResourceContext } from '../../../l1/resources/sourceResources.js';
import type { UiMessage } from '../state/foregroundTask.js';
import type { ExportIssueCollector } from '../state/exportIssues.js';
import { createBackoffNotice } from '../../shared/backoffNotice.js';
import { text } from '../../shared/settings.js';

/** Bounded, per-run UI evidence. It never becomes Domain or ExportRecord data. */
export interface ExportRunDiagnostic {
    startedAt: number;
    finishedAt?: number;
    request: UIExportRequest;
    items: (ExportItemUpdate & { at: number; title?: string })[];
    diagnostics: (ExportDiagnostic & { at: number; title?: string })[];
    droppedDiagnostics: number;
    issues: ExportIssueCollector;
    result?: ExportResult;
    error?: string;
}
interface ExportSessionOptions {
    signal: AbortSignal;
    importedResources: SourceResourceContext;
    prepare: () => Promise<void>;
    titleFor: (key: ConversationKey | undefined) => string | undefined;
    onStart: (message: UiMessage) => void;
    onProgress: (message: UiMessage, percent: number) => void;
    onItemUpdate: (update: ExportItemUpdate) => void;
    onBodyDelivered: (key: ConversationKey) => void;
    onIssuesChanged: () => void;
}

/** Adapt Application observations to UI progress and evidence, without DOM or React. */
export async function runExportSession(run: ExportRunDiagnostic, options: ExportSessionOptions) {
    const { request } = run;
    const processed = new Set<string>();
    const prepared = new Set<string>();
    const delivered = new Set<string>();
    let downloaded = 0;
    let active = true;
    const backoff = createBackoffNotice();
    const message = () => text(
        `Prepared ${prepared.size} conversations · delivered ${delivered.size} documents · downloaded ${downloaded} attachments`,
        `已准备 ${prepared.size} 条会话 · 已交付正文 ${delivered.size} 条 · 已下载 ${downloaded} 个附件`)
        + (backoff.message() ? ` · ${backoff.message()}` : '');
    const paintProgress = () => {
        if (!active) return;
        const total = request.keys.length;
        // Browser batches reserve their last 10% for the final ZIP handoff.
        const percent = total ? Math.round(processed.size / total *
            (request.delivery === 'browserDownload' ? 90 : 100)) : 100;
        options.onProgress(message, percent);
    };
    options.onStart(message);
    paintProgress();
    const timer = setInterval(() => { if (backoff.message()) paintProgress(); }, 1000);
    try {
        await options.prepare();
        const result = await runExport(request, {
            signal: options.signal, importedResources: options.importedResources,
            onDiagnostic: diagnostic => {
                if (!active) return;
                backoff.observe(diagnostic);
                if (['CHATGPT_BACKOFF_WAIT', 'CHATGPT_BACKOFF_END', 'CHATGPT_RATE_LIMITED', 'CHATGPT_COOLDOWN_ACTIVE'].includes(diagnostic.code)) paintProgress();
                // Failed items carry their diagnostic; count it once via onItemUpdate.
                if (diagnostic.code !== 'EXPORT_FAILED') {
                    run.issues.add(diagnostic, options.titleFor(diagnostic.key));
                    options.onIssuesChanged();
                }
                if (run.diagnostics.length >= 10000) { run.droppedDiagnostics++; return; }
                run.diagnostics.push({ ...diagnostic, at: Date.now(), title: options.titleFor(diagnostic.key) });
            },
            onConversationPrepared: key => {
                if (!active) return;
                prepared.add(`${key.accountId}/${key.conversationId}`);
                paintProgress();
            },
            onBodyDelivered: key => {
                if (!active) return;
                delivered.add(`${key.accountId}/${key.conversationId}`);
                options.onBodyDelivered(key);
                paintProgress();
            },
            onResourceProgress: progress => { if (active) { downloaded = progress.downloaded; paintProgress(); } },
            onItemUpdate: update => {
                if (!active) return;
                if (update.status === 'failed') run.issues.add(update.diagnostic, options.titleFor(update.key));
                run.items.push({ ...update, at: Date.now(), title: options.titleFor(update.key) });
                processed.add(`${update.key.accountId}/${update.key.conversationId}`);
                if (update.status === 'exported') delivered.add(`${update.key.accountId}/${update.key.conversationId}`);
                options.onItemUpdate(update);
                paintProgress();
            },
        });
        run.result = result;
        return { result, deliveredCount: delivered.size };
    } catch (error) {
        run.error = error instanceof Error ? error.message : String(error);
        throw error;
    } finally { active = false; clearInterval(timer); run.finishedAt = Date.now(); }
}
