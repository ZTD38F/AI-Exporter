import { buildExportFileName } from '../../../utils/pathUtils.js';
import type {
    ArtifactWriteReport,
    RenderDiagnostic,
} from '../../canonical/rendering.js';
import type { IExportWriter } from '../../../engine/writers/writerInterface.js';
import {
    StageError,
    type DeliveryStageInput,
    type DeliveryStageOutput,
    type StageContext,
    type StageFn,
} from './types.js';

function abortIfCancelled(ctx: StageContext, where = "stage 'deliver'"): void {
    if (ctx.signal.aborted) {
        throw new DOMException(`Pipeline aborted during ${where}`, 'AbortError');
    }
}

function errorDiag(code: string, message: string, path?: string): RenderDiagnostic {
    return { severity: 'error', code, message, path };
}

function fail(
    ctx: StageContext,
    label: string,
    code: string,
    message: string,
    options: { retryable: boolean; cause?: unknown; diagnostics?: RenderDiagnostic[] },
): never {
    ctx.log(`[PDF] ${label} deliver failed: ${message}`, 'error');
    throw new StageError('deliver', code, message, options);
}

/** Writes the PDF to the writer; in ZIP mode this only stages the entry in memory (finalized: false). */
export const deliverStage: StageFn<DeliveryStageInput, DeliveryStageOutput> = async (
    input: DeliveryStageInput,
    ctx: StageContext,
): Promise<{ output: DeliveryStageOutput; diagnostics: RenderDiagnostic[] }> => {
    const { conversationId, title, pdfBytes, useZip, writer } = input;
    const label = title || conversationId;
    const fileName = buildExportFileName(title, conversationId, 'pdf');

    if (useZip && typeof input.downloadHandler !== 'function') {
        const message =
            'zip export requires downloadHandler: without it the batch ZIP can never be delivered to the user';
        fail(ctx, label, 'MISSING_DOWNLOAD_HANDLER', message, {
            retryable: false,
            diagnostics: [errorDiag('MISSING_DOWNLOAD_HANDLER', message, conversationId)],
        });
    }

    abortIfCancelled(ctx);

    try {
        await writer.writeFile(fileName, pdfBytes);
    } catch (e: unknown) {
        const message = `writeFile failed for ${fileName}: ${(e as Error)?.message ?? String(e)}`;
        fail(ctx, label, 'WRITE_FAILED', message, {
            retryable: true,
            cause: e,
            diagnostics: [errorDiag('WRITE_FAILED', message, conversationId)],
        });
    }

    const writeReport: ArtifactWriteReport = {
        fileName,
        target: useZip ? 'zip' : 'folder',
        bytesWritten: pdfBytes.byteLength,
        writtenAt: new Date().toISOString(),
    };

    if (!useZip) {
        ctx.log(`[PDF] ${label} 导出成功 (${fileName})`, 'info');
        return { output: { writeReport, finalized: true }, diagnostics: [] };
    }

    ctx.log(`[PDF] ${label} 已暂存到 ZIP (${fileName})`, 'info');
    return { output: { writeReport, finalized: false }, diagnostics: [] };
};

export async function finalizeZipDelivery(
    writer: IExportWriter,
    downloadHandler: (blob: Blob, filename: string) => void | Promise<void>,
    zipFileName: string,
    ctx: StageContext,
): Promise<{ bytesWritten: number }> {
    abortIfCancelled(ctx, 'ZIP finalize');

    if (typeof downloadHandler !== 'function') {
        const message =
            'zip finalize requires downloadHandler: without it the batch ZIP can never be delivered to the user';
        fail(ctx, zipFileName, 'MISSING_DOWNLOAD_HANDLER', message, {
            retryable: false,
            diagnostics: [errorDiag('MISSING_DOWNLOAD_HANDLER', message, zipFileName)],
        });
    }

    if (typeof writer.generateBlob !== 'function') {
        const message =
            'writer.generateBlob is not available; cannot finalize batch ZIP; staged items are NOT delivered';
        fail(ctx, zipFileName, 'ZIP_FINALIZE_UNAVAILABLE', message, {
            retryable: false,
            diagnostics: [errorDiag('ZIP_FINALIZE_UNAVAILABLE', message, zipFileName)],
        });
    }

    let blob: Blob;
    try {
        blob = await writer.generateBlob();
    } catch (e: unknown) {
        const message = `batch ZIP finalize failed: ${(e as Error)?.message ?? String(e)}; staged items are NOT delivered`;
        fail(ctx, zipFileName, 'ZIP_FINALIZE_FAILED', message, {
            retryable: true,
            cause: e,
            diagnostics: [errorDiag('ZIP_FINALIZE_FAILED', message, zipFileName)],
        });
    }

    try {
        await downloadHandler(blob, zipFileName);
    } catch (e: unknown) {
        const message = `batch ZIP download failed for ${zipFileName}: ${(e as Error)?.message ?? String(e)}; the ZIP was generated but NOT delivered to the user`;
        fail(ctx, zipFileName, 'DOWNLOAD_FAILED', message, {
            retryable: true,
            cause: e,
            diagnostics: [errorDiag('DOWNLOAD_FAILED', message, zipFileName)],
        });
    }

    ctx.log(`[PDF] ZIP 批量交付成功 (${zipFileName})`, 'info');
    return { bytesWritten: blob.size };
}
