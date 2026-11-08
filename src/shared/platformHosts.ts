export const SOURCE_PLATFORMS = ['gemini', 'chatgpt', 'grok', 'claude'] as const;
export type SourcePlatform = typeof SOURCE_PLATFORMS[number];
/** Only Gemini is enabled; preserve dormant provider types for future integration. */
export const ACTIVE_SOURCE_PLATFORMS = ['gemini'] as const satisfies readonly SourcePlatform[];

/** Site access is requested as one independent group per source platform. */
export const PLATFORM_HOSTS = {
    gemini: {
        pages: ['https://gemini.google.com/*'],
        attachments: ['https://*.googleusercontent.com/*', 'https://*.usercontent.google.com/*',
            'https://drive.google.com/*', 'https://lh3.google.com/*', 'https://*.gstatic.com/*'],
    },
    chatgpt: {
        pages: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
        attachments: ['https://images.openai.com/*'],
    },
    grok: { pages: ['https://grok.com/*'], attachments: ['https://assets.grok.com/*'] },
    claude: { pages: ['https://claude.ai/*'], attachments: [] },
} as const satisfies Record<SourcePlatform, { pages: readonly string[]; attachments: readonly string[] }>;
export function platformOrigins(platform: SourcePlatform): string[] {
    return [...PLATFORM_HOSTS[platform].pages, ...PLATFORM_HOSTS[platform].attachments];
}

/** External image access is separate from platform connection and granted per origin. */
export const RESOURCE_DOWNLOAD_ORIGINS = ['https://cdn.sanity.io/*'] as const;
export function resourceDownloadOrigin(uri: string): string | undefined {
    try {
        const url = new URL(uri);
        if (url.protocol !== 'https:' || url.username || url.password) return undefined;
        return RESOURCE_DOWNLOAD_ORIGINS.find(origin => origin === `${url.origin}/*`);
    } catch { return undefined; }
}
