import { resourceDownloadOrigin, platformOrigins, type SourcePlatform } from '../../shared/platformHosts.js';

export async function hasPlatformAccess(platform: SourcePlatform): Promise<boolean> {
    if (typeof chrome === 'undefined' || !chrome.permissions?.contains) return false;
    try { return await chrome.permissions.contains({ origins: platformOrigins(platform) }); }
    catch { return false; }
}

/** Request the union once, before any await can consume the click gesture. */
export async function requestPlatformsAccess(platforms: readonly SourcePlatform[]): Promise<boolean> {
    const origins = [...new Set(platforms.flatMap(platformOrigins))];
    if (!origins.length) return false;
    if (typeof chrome === 'undefined' || !chrome.permissions?.request) return false;
    try { return await chrome.permissions.request({ origins }); }
    catch { return false; }
}

export async function hasResourceAccess(uri: string): Promise<boolean> {
    const origin = resourceDownloadOrigin(uri);
    if (!origin || typeof chrome === 'undefined' || !chrome.permissions?.contains) return false;
    try { return await chrome.permissions.contains({ origins: [origin] }); }
    catch { return false; }
}

/** Start only from a user click; the grant covers one declared external origin. */
export async function requestResourceAccess(uri: string): Promise<boolean> {
    const origin = resourceDownloadOrigin(uri);
    if (!origin || typeof chrome === 'undefined' || !chrome.permissions?.request) return false;
    try { return await chrome.permissions.request({ origins: [origin] }); }
    catch { return false; }
}
