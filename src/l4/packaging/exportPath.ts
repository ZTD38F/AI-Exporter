import { OperationError } from '../../shared/errors/operationError.js';
import { sanitizeRelativePath } from '../../shared/utils/pathUtils.js';
import { normalizeArchivePath } from '../../shared/utils/archivePath.js';

/** Writers accept the planned path verbatim or reject it. */
export function assertExportPath(path: string): void {
    if (!path || normalizeArchivePath(path) !== path || sanitizeRelativePath(path) !== path) {
        throw new OperationError('PACKAGING_FAILED', `Noncanonical export path: ${path}`);
    }
}
