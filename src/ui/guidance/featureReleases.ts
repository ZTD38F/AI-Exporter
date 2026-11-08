import { isVersionGreater } from '../../shared/utils/pathUtils.js';
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
    return FEATURE_RELEASES.find(feature => !isVersionGreater(feature.version, current) && isVersionGreater(feature.version, baseline)) ?? null;
}
