// src/ui/tour/featureReleases.ts - Registry for major version feature announcements
export interface FeatureReleaseConfig {
    version: string;
    featureId: string;
    stepId: string;
    badgeKey?: string;
}

/**
 * Ordered list of feature releases eligible for one-time spotlight announcement.
 * When an existing user upgrades and their last_seen_feature_version is lower than the release version,
 * the spotlight for the highest eligible unvisited release is shown.
 */
export const FEATURE_RELEASES: FeatureReleaseConfig[] = [
    {
        version: '1.5.0',
        featureId: 'live_save',
        stepId: 'live_save',
        badgeKey: 'tourFeatureBadge'
    }
];

export function getLatestEligibleFeature(lastSeenVersion: string, currentAppVersion: string): FeatureReleaseConfig | null {
    const effectiveLastSeen = lastSeenVersion || '1.0.0';

    const StorageService = (typeof globalThis !== 'undefined' && (globalThis as any).StorageService) ? (globalThis as any).StorageService : null;
    const isGreater = (StorageService && StorageService.isVersionGreater) ? StorageService.isVersionGreater : ((v1: string, v2: string) => {
        const p1 = String(v1).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
        const p2 = String(v2).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
        const maxLen = Math.max(p1.length, p2.length);
        for (let i = 0; i < maxLen; i++) {
            if ((p1[i] || 0) > (p2[i] || 0)) return true;
            if ((p1[i] || 0) < (p2[i] || 0)) return false;
        }
        return false;
    });

    for (const rel of FEATURE_RELEASES) {
        if (!isGreater(rel.version, currentAppVersion) && isGreater(rel.version, effectiveLastSeen)) {
            return rel;
        }
    }
    return null;
}
