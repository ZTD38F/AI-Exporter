import { hasPlatformAccess } from '../../l1/client/platformAccess.js';
import { PLATFORM_HOSTS, ACTIVE_SOURCE_PLATFORMS, type SourcePlatform } from '../../shared/platformHosts.js';

const files = {
    gemini: ['dist/content/hook.js', 'dist/content/content.js'],
    chatgpt: ['dist/content/chatgpt-hook.js', 'dist/content/chatgpt-content.js'],
    grok: ['dist/content/grok-hook.js', 'dist/content/grok-content.js'],
    claude: ['dist/content/claude-hook.js', 'dist/content/claude-content.js'],
} as const;
const pending = new Map<SourcePlatform, Promise<void>>();
/** Serialize permission events so simultaneous startup/grant checks cannot double-register. */
export function syncPlatformContentScripts(platform: SourcePlatform): Promise<void> {
    const job = (pending.get(platform) ?? Promise.resolve()).catch(() => {}).then(async () => {
        if (!chrome.scripting?.getRegisteredContentScripts) return;
        const ids = [`${platform}-source-main`, `${platform}-source-content`];
        const registered = await chrome.scripting.getRegisteredContentScripts({ ids });
        if (!await hasPlatformAccess(platform)) {
            if (registered.length) {
                try { await chrome.scripting.unregisterContentScripts({ ids: registered.map(item => item.id) }); }
                catch (error) {
                    if ((await chrome.scripting.getRegisteredContentScripts({ ids })).length) throw error;
                }
            }
            return;
        }
        const missing = ids.filter(id => !registered.some(item => item.id === id));
        const descriptors: chrome.scripting.RegisteredContentScript[] = missing.map(id => ({
            id, matches: [...PLATFORM_HOSTS[platform].pages], runAt: 'document_start',
            allFrames: false, persistAcrossSessions: true,
            ...(id === ids[1] ? { css: ['src/ui/badge/content.css'] } : {}),
            js: [files[platform][id === ids[0] ? 0 : 1]],
            world: id === ids[0] ? 'MAIN' : 'ISOLATED',
        }));
        if (descriptors.length) {
            try { await chrome.scripting.registerContentScripts(descriptors); }
            catch (error) {
                // Background permission events and Options use different JS realms.
                // Another owner may already have installed exactly the same scripts.
                const actual = await chrome.scripting.getRegisteredContentScripts({ ids });
                const signature = (script: chrome.scripting.RegisteredContentScript) => JSON.stringify([
                    script.matches, script.js, script.css ?? [], script.world, script.runAt,
                    script.allFrames, script.persistAcrossSessions,
                ]);
                if (!await hasPlatformAccess(platform) || !descriptors.every(expected =>
                    actual.some(script => script.id === expected.id && signature(script) === signature(expected)))) throw error;
            }
        }
    });
    pending.set(platform, job);
    void job.finally(() => { if (pending.get(platform) === job) pending.delete(platform); }).catch(() => {});
    return job;
}
export function syncAllPlatformContentScripts(): Promise<void[]> {
    return Promise.all(ACTIVE_SOURCE_PLATFORMS.map(syncPlatformContentScripts));
}

/** Activate an already open tab after Connect; future documents use registrations. */
export async function preparePlatformTab(platform: SourcePlatform, tabId: number): Promise<void> {
    if (!await hasPlatformAccess(platform)) throw new Error(`${platform} host permission unavailable`);
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url;
    if (!url || !PLATFORM_HOSTS[platform].pages.some(pattern => new URL(url).origin === pattern.slice(0, -2)))
        throw new Error('Provider tab does not match the selected platform');
    await syncPlatformContentScripts(platform);
    try {
        if (await chrome.tabs.sendMessage(tabId, { action: 'getAccountContext' })) return;
    } catch { /* A tab opened before its grant has no Content receiver yet. */ }
    await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: [files[platform][0]] });
    await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', files: [files[platform][1]] });
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['src/ui/badge/content.css'] });
}
