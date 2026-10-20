import type { Asset, AssetStatus } from './assets.js';
import type { Diagnostic } from './diagnostics.js';

export interface ClassifiedAsset {
    asset: Asset;
    effectiveStatus: AssetStatus;
    pseudoAvailable: boolean;
    diagnostic?: Diagnostic;
}

/** Downgrade metadata-only 'available' status to 'missing' when bytes are unresolvable so offline exports never silently link remote URLs. */
export function classifyAssetAvailability(asset: Asset, hasBytes: boolean): ClassifiedAsset {
    const base: ClassifiedAsset = { asset, effectiveStatus: asset.status, pseudoAvailable: false };
    if (asset.status === 'available' && !hasBytes) {
        base.effectiveStatus = 'missing';
        base.pseudoAvailable = true;
        base.diagnostic = {
            id: `pseudo-available:${asset.id}`,
            severity: 'warning',
            code: 'PSEUDO_AVAILABLE',
            message: `asset ${asset.id} was marked 'available' but no bytes could be resolved; treating as missing`,
            details: { storageRef: asset.storageRef ?? null, sourceUrl: asset.sourceUrl ?? null },
        };
    }
    return base;
}

export interface AssetByteSource {
    getBytes(asset: Asset): Promise<Uint8Array | null>;
}

export interface ResolvedAssetBytes {
    asset: Asset;
    bytes: Uint8Array | null;
    effectiveStatus: AssetStatus;
    failureReason?: string;
    diagnostics: Diagnostic[];
}

export async function resolveAssetBytes(asset: Asset, byteSource: AssetByteSource): Promise<ResolvedAssetBytes> {
    const diagnostics: Diagnostic[] = [];
    let bytes: Uint8Array | null = null;
    try {
        bytes = await byteSource.getBytes(asset);
    } catch (err) {
        diagnostics.push({
            id: `asset-fetch-error:${asset.id}`,
            severity: 'warning',
            code: 'ASSET_FETCH_ERROR',
            message: `failed to fetch bytes for asset ${asset.id}: ${err instanceof Error ? err.message : String(err)}`,
        });
    }
    const classified = classifyAssetAvailability(asset, bytes !== null);
    if (classified.diagnostic) diagnostics.push(classified.diagnostic);
    return {
        asset,
        bytes,
        effectiveStatus: classified.effectiveStatus,
        failureReason: classified.pseudoAvailable
            ? (asset.failureReason ?? 'marked available but bytes could not be resolved')
            : asset.failureReason,
        diagnostics,
    };
}
