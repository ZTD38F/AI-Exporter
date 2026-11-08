import type { ResourceRequest } from '../src/l1/resources/resourceAcquisition.js';
import type { ResourceBytes, ResourceDelivery, ResourceResult } from '../src/shared/resources/resourceResult.js';

// @ts-expect-error Runtime resource identity must be a Domain asset ID, never just a URL.
const anonymous: ResourceRequest = { url: 'https://example.test/image.png' };
// @ts-expect-error A successful acquisition always has bytes.
const emptySuccess: ResourceResult<ResourceBytes> = { ok: true, resourceId: 'image', value: { mediaType: 'image/png' } };
// @ts-expect-error A successful delivery always has the actual output path.
const noPath: ResourceResult<ResourceDelivery> = { ok: true, resourceId: 'image', value: {} };
// @ts-expect-error Failures cannot claim success payloads.
const failedBytes: ResourceResult<ResourceBytes> = { ok: false, resourceId: 'image', code: 'HTTP_NOT_FOUND', reason: 'HTTP 404', value: { bytes: new Uint8Array() } };
void [anonymous, emptySuccess, noPath, failedBytes];
