import type { Diagnostic } from '../../../shared/diagnostics/diagnostic.js';
import { scanAll } from '../../../application/sync/scanController.js';
import type { ScanProgress, ScanResult } from '../../../application/sync/scanController.js';
import { resolveScanTarget } from '../../../runtime/capabilities/tabService.js';

/** Consume Runtime's source resolution; never infer source identity in UI. */
export async function startSync(preferredAccountId: string | undefined, options: {
    signal: AbortSignal; forceFull?: boolean;
    onTarget: (id: string) => Promise<void>;
    onProgress?: (progress: ScanProgress) => void;
    onDiagnostic?: (diagnostic: Diagnostic) => void;
}, ports = {
    resolveScanTarget, scanAll
}): Promise<ScanResult> {
    const accountId = await ports.resolveScanTarget(preferredAccountId);
    options.signal.throwIfAborted();
    await options.onTarget(accountId);
    options.signal.throwIfAborted();
    return ports.scanAll({ accountId, ...(options.forceFull ? { forceFull: true } : {}) },
        { signal: options.signal, onProgress: options.onProgress, onDiagnostic: options.onDiagnostic });
}
