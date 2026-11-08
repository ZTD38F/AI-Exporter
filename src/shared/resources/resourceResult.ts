import { OperationError, operationIssue, type OperationIssue } from '../errors/operationError.js';
/** Transport encodings are normalized once; successful acquisition always contains bytes. */
export interface ResourceBytes { bytes: Uint8Array; mediaType?: string; name?: string }
/** Only a successful write/mount produces a delivery receipt. */
export interface ResourceDelivery { path: string }
/** A recoverable resource failure is separate from conversation/source facts. */
export type ResourceResult<T extends ResourceBytes | ResourceDelivery = ResourceBytes> =
    | { ok: true; resourceId: string; value: T }
    | { ok: false; resourceId: string; reason: string; code: string; issue?: OperationIssue; httpStatus?: number; sourceUrl?: string };
export type ResourceFailure = Extract<ResourceResult<never>, { ok: false }>;
export type PreparedResources = ReadonlyMap<string, ResourceResult>;

export function missingResource(resourceId: string, reason: string, code = 'RESOURCE_UNAVAILABLE'): ResourceFailure {
    return { ok: false, resourceId, reason, code };
}
/** Cancellation retains control-flow semantics; only individual resource errors recover. */
export async function attemptResource(resourceId: string, work: () => Promise<ResourceBytes>, signal?: AbortSignal | null): Promise<ResourceResult> {
    signal?.throwIfAborted();
    try {
        const value = await work();
        signal?.throwIfAborted();
        return { ok: true, resourceId, value };
    } catch (error) {
        signal?.throwIfAborted();
        if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') throw error;
        if (error instanceof ResourceProcessingError) return { ...missingResource(resourceId, error.message, 'RESOURCE_PROCESSING_FAILED'),
            issue: { code: 'RESOURCE_PROCESSING_FAILED', message: error.message } };
        if (error instanceof ResourceHttpError) {
            const status = error.httpStatus;
            const code = status === 404 || status === 410 ? 'RESOURCE_SOURCE_EXPIRED'
                : status === 401 || status === 403 ? 'RESOURCE_ACCESS_RESTRICTED' : 'RESOURCE_DOWNLOAD_FAILED';
            return { ...missingResource(resourceId, error.message, code), httpStatus: status,
                issue: { code, message: error.message, httpStatus: status } };
        }
        if (error instanceof OperationError) return { ...missingResource(resourceId, error.message, error.code),
            ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}), issue: operationIssue(error) };
        return missingResource(resourceId, error instanceof Error ? error.message : String(error));
    }
}
/** Only an actual attachment response status establishes source unavailability. */
export class ResourceHttpError extends Error {
    constructor(readonly httpStatus: number) { super(`Resource request failed: HTTP ${httpStatus}`); }
}
type ResourceIssueKind = 'expired' | 'restricted' | 'download' | 'processing' | 'unknown';
export function resourceIssueKind(failure: Pick<ResourceFailure, 'code' | 'httpStatus' | 'issue'>): ResourceIssueKind {
    if (failure.code === 'RESOURCE_LOCATOR_UNAVAILABLE' && failure.httpStatus === 404) return 'expired';
    if (failure.code === 'SOURCE_HTTP_ERROR' || failure.code === 'RESOURCE_LOCATOR_UNAVAILABLE' && failure.httpStatus !== undefined) {
        const status = failure.httpStatus ?? failure.issue?.httpStatus;
        return status === 401 || status === 403 ? 'restricted' : 'download';
    }
    if (failure.code === 'RESOURCE_SOURCE_EXPIRED') return 'expired';
    if (failure.code === 'RESOURCE_ACCESS_RESTRICTED') return 'restricted';
    if (['RESOURCE_PROCESSING_FAILED', 'RESOURCE_SIZE_LIMIT', 'RESOURCE_SIZE_MISMATCH',
        'TYPST_ASSET_DECODE_FAILED', 'TYPST_ASSET_EMPTY'].includes(failure.code)) return 'processing';
    if (failure.code === 'RESOURCE_DOWNLOAD_FAILED') return 'download';
    return 'unknown';
}
export function resourceFailureText(failure: ResourceFailure, locale: 'zh' | 'en'): string {
    const kind = resourceIssueKind(failure);
    const labels = locale === 'zh'
        ? { expired: '来源附件无法获取', restricted: '附件访问受限', download: '附件下载失败，请稍后重试', processing: '附件无法处理', unknown: '附件失败：未知错误' }
        : { expired: 'Source attachment unavailable', restricted: 'Attachment access restricted', download: 'Attachment download failed; please retry later', processing: 'Attachment could not be processed', unknown: 'Attachment failed: Unknown error' };
    return labels[kind] + (failure.httpStatus ? ` (HTTP ${failure.httpStatus})` : '');
}

export class ResourceProcessingError extends Error {}
