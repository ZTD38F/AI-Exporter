export { createInlineByteStore } from './byteStore.js';
export type { InlineByteStore } from './byteStore.js';
export { sha256Hex } from './sha256.js';
export { decodeDataUrl, decodeDataUrlAsset, buildDataUrlStorageRef, INLINE_DATA_URL_MAX_BYTES } from './dataUrl.js';
export type {
    DecodedDataUrlBytes,
    DecodedDataUrlAsset,
    DataUrlDecodeError,
    DataUrlDecodeErrorCode,
    DataUrlDecodeResult,
    DataUrlBytesResult,
} from './dataUrl.js';
export { resolveAssets, buildVirtualAssetPath, MAX_ASSET_BYTES } from './resolver.js';
export type {
    AssetResolverOptions,
    InlineByteSource,
    ResolveAssetsResult,
    ResolvedAssetEntry,
} from './resolver.js';
