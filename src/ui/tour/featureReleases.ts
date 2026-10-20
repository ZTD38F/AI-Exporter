import { isVersionGreater } from '../../core/utils/pathUtils.js';

export interface FeatureReleaseConfig {
    version: string;
    featureId: string;
    stepId: string;
    badgeKey?: string;
}

// Feature releases eligible for one-time spotlight announcement on extension upgrade
export const FEATURE_RELEASES: FeatureReleaseConfig[] = [
    {
        version: '1.7.0',
        featureId: 'pdf_html_export',
        stepId: 'export',
        badgeKey: 'tourFeatureBadge'
    },
    {
        version: '1.5.0',
        featureId: 'live_save',
        stepId: 'live_save',
        badgeKey: 'tourFeatureBadge'
    }
];

export function getLatestEligibleFeature(lastSeenVersion: string, currentAppVersion: string): FeatureReleaseConfig | null {
    const effectiveLastSeen = lastSeenVersion || '1.0.0';

    for (const rel of FEATURE_RELEASES) {
        if (!isVersionGreater(rel.version, currentAppVersion) && isVersionGreater(rel.version, effectiveLastSeen)) {
            return rel;
        }
    }
    return null;
}

