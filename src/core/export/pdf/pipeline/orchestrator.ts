import { isAbortError } from '../errors.js';
import { runStage } from './runner.js';
import {
    PIPELINE_STAGE_ORDER,
    StageError,
    type PipelineContext,
    type PipelineItemInput,
    type PipelineItemResult,
    type PipelineStageName,
    type PipelineStages,
    type RenderDiagnostic,
    type StageContext,
} from './types.js';

export class PdfPipeline {
    constructor(private readonly stages: PipelineStages) {}

    async runOne(input: PipelineItemInput, pctx: PipelineContext): Promise<PipelineItemResult> {
        const diagnostics: RenderDiagnostic[] = [];
        const ctx: StageContext = {
            signal: pctx.signal,
            reportProgress: pctx.reportProgress,
            log: pctx.log,
        };
        const { conversationId, title } = input;

        const fail = (
            stage: PipelineStageName | 'pipeline',
            code: string,
            message: string,
            retryable: boolean,
        ): PipelineItemResult => ({
            conversationId,
            title,
            status: 'failed',
            error: { stage, code, message, retryable },
            diagnostics,
        });

        try {
            ctx.reportProgress('resources', 0, PIPELINE_STAGE_ORDER.length);
            const resources = await runStage('resources', this.stages.resources, {
                bundle: input.bundle,
                byteStore: input.byteStore,
            }, ctx);
            diagnostics.push(...resources.diagnostics);

            ctx.reportProgress('payload', 1, PIPELINE_STAGE_ORDER.length);
            const payload = await runStage('payload', this.stages.payload, {
                bundle: input.bundle,
                pathMap: resources.output.pathMap,
                locale: input.locale,
            }, ctx);
            diagnostics.push(...payload.diagnostics);

            ctx.reportProgress('compile', 2, PIPELINE_STAGE_ORDER.length);
            const compiled = await runStage('compile', this.stages.compile, {
                payload: payload.output.payload,
                bundle: input.bundle,
                mounts: resources.output.mounts,
                pathMap: resources.output.pathMap,
                fonts: input.fonts,
                compiler: input.compiler,
                locale: input.locale,
            }, ctx);
            diagnostics.push(...compiled.diagnostics);

            ctx.reportProgress('deliver', 3, PIPELINE_STAGE_ORDER.length);
            const delivered = await runStage('deliver', this.stages.deliver, {
                conversationId: input.conversationId,
                title: input.title,
                pdfBytes: compiled.output.pdfBytes,
                useZip: input.useZip,
                writer: input.writer,
                downloadHandler: input.downloadHandler,
                folderName: input.folderName,
            }, ctx);
            diagnostics.push(...delivered.diagnostics);

            ctx.reportProgress('done', PIPELINE_STAGE_ORDER.length, PIPELINE_STAGE_ORDER.length);
            if (delivered.output.finalized) {
                return {
                    conversationId,
                    title,
                    status: 'delivered',
                    writeReport: delivered.output.writeReport,
                    diagnostics,
                };
            }
            return {
                conversationId,
                title,
                status: 'staged',
                stagedArtifact: {
                    fileName: delivered.output.writeReport.fileName,
                    bytesWritten: delivered.output.writeReport.bytesWritten,
                },
                diagnostics,
            };
        } catch (e) {
            if (isAbortError(e)) {
                return { conversationId, title, status: 'aborted', diagnostics };
            }
            if (e instanceof StageError) {
                ctx.log(
                    `[PDF] ${title || conversationId} pipeline failed at stage '${e.stage}': ${e.message}`,
                    'error',
                );
                diagnostics.push(...e.diagnostics);
                return fail(e.stage, e.code, e.message, e.retryable);
            }
            const message = (e as Error)?.message ?? String(e);
            ctx.log(`[PDF] ${title || conversationId} pipeline failed: ${message}`, 'error');
            return fail('pipeline', 'PIPELINE_THREW', message, true);
        }
    }
}
