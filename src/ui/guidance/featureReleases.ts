import { isVersionGreater } from '../../shared/utils/pathUtils.js';
import { ACTIVE_SOURCE_PLATFORMS } from '../../shared/platformHosts.js';
type FeatureReleaseConfig =
    | { version: string; stepId: string }
    | { version: string; kind: 'upgrade' | 'platforms' };
// Existing product announcements, newest first. Do not infer announcements from releases.
// Only explicitly approved v2 announcements belong here; do not replay legacy v1 releases.
export const FEATURE_RELEASES: FeatureReleaseConfig[] = [
    { version: '2.1.0', kind: 'platforms' },
    { version: '2.0.0', kind: 'upgrade' },
];
export function getLatestEligibleFeature(lastSeen: string, current: string): FeatureReleaseConfig | null {
    const baseline = /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(lastSeen) ? lastSeen : current;
    // A Gemini-only build must never advertise unavailable ChatGPT/Claude/Grok support.
    return FEATURE_RELEASES.find(feature => (ACTIVE_SOURCE_PLATFORMS.length > 1
        || !('kind' in feature) || feature.kind !== 'platforms')
        && !isVersionGreater(feature.version, current) && isVersionGreater(feature.version, baseline)) ?? null;
}
