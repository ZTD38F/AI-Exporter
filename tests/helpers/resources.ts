import assert from 'node:assert/strict';
import type { ResourceBytes, ResourceDelivery, ResourceResult, PreparedResources } from '../../src/shared/resources/resourceResult.js';

export function resourceValue<T extends ResourceBytes | ResourceDelivery = ResourceBytes>(result: ResourceResult<T> | undefined): T {
    assert.ok(result?.ok, result && !result.ok ? result.reason : 'missing resource result');
    return result.value;
}
export function preparedResources(entries: Iterable<readonly [string, ResourceBytes]>): PreparedResources {
    return new Map([...entries].map(([resourceId, value]) => [resourceId, { ok: true, resourceId, value }]));
}
