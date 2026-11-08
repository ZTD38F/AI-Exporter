import { normalizeArchivePath } from '../../../shared/utils/archivePath.js';
import { sanitizeRelativePath } from '../../../shared/utils/pathUtils.js';

/** Only Packaging's already-canonical relative paths are valid resource bindings. */
export function isResourcePath(path: string | undefined): path is string {
    if (!path) return false;
    try {
        return normalizeArchivePath(path) === path && sanitizeRelativePath(path) === path;
    } catch {
        return false;
    }
}
