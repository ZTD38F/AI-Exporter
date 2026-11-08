/** Failure facts classified by the boundary that observed them, never by message matching. */
const OPERATION_ERROR_CODES = [
    'ACCOUNT_UNAVAILABLE', 'ACCOUNT_CHANGED', 'PLATFORM_PERMISSION_REQUIRED', 'SOURCE_PAGE_UNAVAILABLE', 'SOURCE_AUTH_UNAVAILABLE', 'SOURCE_HTTP_ERROR', 'SOURCE_RESPONSE_INVALID', 'SOURCE_CHANGED', 'CONVERSATION_NOT_FOUND', 'DETAIL_UNAVAILABLE', 'RESOURCE_LOCATOR_UNAVAILABLE', 'RESOURCE_METADATA_UNAVAILABLE', 'RESOURCE_SIZE_LIMIT', 'RESOURCE_SIZE_MISMATCH', 'RESOURCE_SOURCE_EXPIRED', 'RESOURCE_ACCESS_RESTRICTED', 'RESOURCE_DOWNLOAD_FAILED', 'RESOURCE_PROCESSING_FAILED', 'DIRECTORY_UNAVAILABLE', 'DIRECTORY_PERMISSION_REQUIRED', 'FILE_WRITE_FAILED', 'PACKAGING_FAILED', 'PACKAGING_SIZE_LIMIT', 'PACKAGING_UNAVAILABLE', 'RECORD_WRITE_FAILED', 'PDF_INIT_FAILED', 'PDF_TIMEOUT', 'PDF_COMPILE_FAILED', 'PDF_INVALID_OUTPUT', 'UNKNOWN_ERROR'
] as const;
export type OperationErrorCode = typeof OPERATION_ERROR_CODES[number];
export interface OperationIssue { code: OperationErrorCode; message: string; httpStatus?: number }
export class OperationError extends Error {
    constructor(readonly code: OperationErrorCode, message: string, readonly httpStatus?: number, options?: ErrorOptions) {
        super(message, options);
        this.name = 'OperationError';
    }
}
export function operationIssue(error: unknown, fallback: OperationErrorCode = 'UNKNOWN_ERROR'): OperationIssue {
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    return { code: error instanceof OperationError ? error.code : fallback,
        message: message.trim() ? message : 'Unknown error',
        ...(error instanceof OperationError && error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}) };
}
/** Preserve a known cause when adding operation context at a narrower failure boundary. */
export function operationError(error: unknown, fallback: OperationErrorCode): OperationError {
    if (error instanceof OperationError) return error;
    return new OperationError(fallback, operationIssue(error).message, undefined, { cause: error });
}

/** Decode only the error facts crossing a real browser/message boundary. */
export function readOperationIssue(value: unknown): OperationIssue | null {
    if (!value || typeof value !== 'object' || !('code' in value) || !('message' in value)
        || typeof value.message !== 'string') return null;
    const code = OPERATION_ERROR_CODES.find(code => code === value.code);
    if (!code) return null;
    if ('httpStatus' in value && value.httpStatus !== undefined && (typeof value.httpStatus !== 'number'
        || !Number.isInteger(value.httpStatus) || value.httpStatus < 100 || value.httpStatus > 599)) return null;
    return { code, message: value.message,
        ...('httpStatus' in value && typeof value.httpStatus === 'number' ? { httpStatus: value.httpStatus } : {}) };
}
