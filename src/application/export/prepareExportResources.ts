import type { DomainAsset } from '../../l2/conversationDetail.js';
import { attemptResource, missingResource, ResourceProcessingError, type PreparedResources, type ResourceBytes,
    type ResourceResult } from '../../shared/resources/resourceResult.js';

export async function prepareExportResources(
    assets: readonly DomainAsset[],
    requiredIds: ReadonlySet<string>,
    acquire: (asset: DomainAsset, signal?: AbortSignal) => Promise<ResourceBytes>,
    signal?: AbortSignal,
    onProgress?: (completed: number, total: number, result?: ResourceResult) => void,
): Promise<PreparedResources> {
    const prepared = new Map<string, ResourceResult>();
    const ids = [...requiredIds];
    const results = new Map<string, ResourceResult>();
    const remaining = ids.values();
    let stopped = false;
    let completed = 0;
    onProgress?.(0, ids.length);
    const worker = async (): Promise<void> => {
        try {
            for (const id of remaining) {
                if (stopped) return;
                signal?.throwIfAborted();
                const asset = assets.find(asset => asset.id === id);
                const result = asset ? await attemptResource(id, async () => {
                    const value = await acquire(asset, signal);
                    if (!value.bytes.byteLength) throw new ResourceProcessingError('Empty resource');
                    return { ...value, mediaType: value.mediaType ?? asset.mediaType, name: value.name ?? asset.name };
                }, signal) : missingResource(id, 'Asset metadata unavailable', 'RESOURCE_METADATA_UNAVAILABLE');
                const sourceUri = asset?.sourceUri;
                results.set(id, !result.ok && sourceUri && /^https:\/\//i.test(sourceUri)
                    ? { ...result, sourceUrl: sourceUri } : result);
                onProgress?.(++completed, ids.length, result);
            }
        } catch (error) {
            stopped = true;
            throw error;
        }
    };
    // A single conversation consumer owns this pool, so the task-wide limit is three.
    const settled = await Promise.allSettled(Array.from({ length: Math.min(3, ids.length) }, worker));
    for (const result of settled) if (result.status === 'rejected') throw result.reason;
    // Completion order must not affect filenames, bindings or rendered attachment order.
    for (const id of ids) {
        const result = results.get(id);
        if (result) prepared.set(id, result);
    }
    return prepared;
}
