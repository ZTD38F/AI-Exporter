import { collectReferencedAssetIds, collectBinaryRenderAssetIds } from '../../canonical/assetReferences.js';
import { resolveAssets } from '../../assets/resolver.js';
import type { Asset, AssetStatus } from '../../canonical/assets.js';
import type {
    ImageMount,
    RenderDiagnostic,
    ResourceStageInput,
    ResourceStageOutput,
    StageContext,
    StageFn,
} from './types.js';

const STAGE_NAME = 'resources';

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
    }
}

function diagFor(
    diagnostics: RenderDiagnostic[],
    assetId: string,
    severity: RenderDiagnostic['severity'],
    code: string,
    message: string,
): void {
    diagnostics.push({ severity, code, message, path: `asset:${assetId}` });
}

function hasWarnPlus(diagnostics: RenderDiagnostic[], assetId: string): boolean {
    const path = `asset:${assetId}`;
    return diagnostics.some(
        (d) => d.path === path && (d.severity === 'warning' || d.severity === 'error'),
    );
}

function unresolvedReason(
    asset: Asset | undefined,
    effectiveStatus: Map<string, AssetStatus>,
): string {
    if (!asset) {
        return 'referenced by conversation messages but absent from bundle.assets';
    }
    const status = effectiveStatus.get(asset.id) ?? asset.status;
    const detail = asset.failureReason ? ` (${asset.failureReason})` : '';
    switch (status) {
        case 'remote':
            return `remote-only; resolver performs no network fetch (offline rule)${detail}`;
        case 'missing':
        case 'notFetched':
        case 'failed':
            return `no bytes resolved (effective status '${status}')${detail}`;
        default:
            return `not resolved (effective status '${status}')${detail}`;
    }
}

export const resourceStage: StageFn<ResourceStageInput, ResourceStageOutput> = async (
    input: ResourceStageInput,
    ctx: StageContext,
) => {
    throwIfAborted(ctx.signal);
    const diagnostics: RenderDiagnostic[] = [];
    const unresolved: ResourceStageOutput['unresolved'] = [];

    // Only image placements require binary resolution; file attachments render as metadata-only cards.
    const byId = new Map<string, Asset>();
    for (const asset of input.bundle.assets) byId.set(asset.id, asset);
    const referencedIds = new Set<string>();
    const binaryIds = new Set<string>();
    for (const message of input.bundle.conversation.messages) {
        throwIfAborted(ctx.signal);
        const blockIds = collectReferencedAssetIds(message.blocks);
        for (const id of blockIds) referencedIds.add(id);
        for (const id of collectBinaryRenderAssetIds(message.blocks)) binaryIds.add(id);
    }
    for (const id of binaryIds) {
        const asset = byId.get(id);
        if (asset && typeof asset.kind === 'string' && asset.kind !== 'image') {
            diagFor(diagnostics, id, 'warning', 'ASSET_KIND_MISMATCH',
                `asset ${id} is referenced by an image placement but its kind is '${asset.kind}'; resolving by placement`);
        }
    }
    const metadataOnlySkipped = referencedIds.size - binaryIds.size;
    ctx.log(
        `[${STAGE_NAME}] ${referencedIds.size} asset reference(s) in conversation messages ` +
        `(${binaryIds.size} binary, ${metadataOnlySkipped} metadata-only skipped before resolution)`,
    );

    const binaryAssets: Asset[] = [];
    for (const id of binaryIds) {
        const asset = byId.get(id);
        if (asset) binaryAssets.push(asset);
    }
    throwIfAborted(ctx.signal);
    const result = await resolveAssets(binaryAssets, input.byteStore);
    throwIfAborted(ctx.signal);
    diagnostics.push(...result.diagnostics);

    const pathMap = result.pathMap;
    const mounts: ImageMount[] = [];
    const mountedPaths = new Set<string>();
    const bytesMissing = new Set<string>();
    for (const assetId of binaryIds) {
        const virtualPath = pathMap.get(assetId);
        if (virtualPath === undefined) continue;
        if (mountedPaths.has(virtualPath)) continue;
        const entry = result.resolved.get(assetId);
        const storageRef = entry?.asset.storageRef;
        const bytes = storageRef !== undefined ? input.byteStore.get(storageRef) : undefined;
        if (bytes === undefined) {
            // Remove from pathMap if bytes are missing from the byteStore so pathMap only contains mountable assets.
            pathMap.delete(assetId);
            bytesMissing.add(assetId);
            const reason = 'resolved to a virtual path but its bytes were unavailable from the byte store';
            unresolved.push({ assetId, reason });
            diagFor(diagnostics, assetId, 'error', 'RESOURCE_BYTES_MISSING',
                `asset ${assetId}: ${reason} (path '${virtualPath}')`);
            continue;
        }
        mountedPaths.add(virtualPath);
        mounts.push({ virtualPath, bytes, mimeType: entry?.mimeType ?? 'application/octet-stream' });
    }

    for (const assetId of binaryIds) {
        if (pathMap.has(assetId)) continue;
        if (bytesMissing.has(assetId)) continue;
        const asset = byId.get(assetId);
        const reason = unresolvedReason(asset, result.effectiveStatus);
        unresolved.push({ assetId, reason });
        if (!hasWarnPlus(diagnostics, assetId)) {
            diagFor(diagnostics, assetId, 'warning', 'RESOURCE_ASSET_UNRESOLVED',
                `asset ${assetId} was referenced by conversation messages but not resolved: ${reason}`);
        }
    }

    ctx.log(
        `[${STAGE_NAME}] resolved ${pathMap.size}, mounts ${mounts.length}, ` +
        `unresolved ${unresolved.length}, diagnostics ${diagnostics.length}, ` +
        `metadata-only skipped before resolution ${metadataOnlySkipped}`,
    );
    ctx.reportProgress(STAGE_NAME, 1, 1);
    return { output: { pathMap, mounts, unresolved }, diagnostics };
};
