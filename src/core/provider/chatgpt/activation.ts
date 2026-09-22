/**
 * Optional ChatGPT provider activation for AI Exporter.
 *
 * Product invariant: ChatGPT access is opt-in. Gemini remains available with
 * the original static content scripts and does not depend on this module.
 */

export const CHATGPT_ORIGIN_PATTERN = "https://chatgpt.com/*";
export const CHATGPT_BRIDGE_SCRIPT_ID = "ai-exporter-chatgpt-bridge-v1";
export const CHATGPT_BRIDGE_FILE = "dist/content/chatgpt.js";

export interface ChatGPTActivationResult {
    granted: boolean;
    registered: boolean;
    injectedTabIds: number[];
    failedTabIds: number[];
}

function ensureChromeActivationApis(): void {
    if (
        typeof chrome === "undefined"
        || !chrome.permissions
        || !chrome.scripting
        || !chrome.tabs
    ) {
        throw new Error("Chrome extension permission/scripting APIs are unavailable");
    }
}

export async function hasChatGPTAccess(): Promise<boolean> {
    ensureChromeActivationApis();
    return chrome.permissions.contains({
        permissions: ["scripting"],
        origins: [CHATGPT_ORIGIN_PATTERN]
    });
}

async function isBridgeRegistered(): Promise<boolean> {
    const scripts = await chrome.scripting.getRegisteredContentScripts({
        ids: [CHATGPT_BRIDGE_SCRIPT_ID]
    });
    return scripts.some(script => script.id === CHATGPT_BRIDGE_SCRIPT_ID);
}

export async function ensureChatGPTBridgeRegistered(): Promise<boolean> {
    ensureChromeActivationApis();

    if (!(await hasChatGPTAccess())) return false;
    if (await isBridgeRegistered()) return true;

    await chrome.scripting.registerContentScripts([{
        id: CHATGPT_BRIDGE_SCRIPT_ID,
        matches: [CHATGPT_ORIGIN_PATTERN],
        js: [CHATGPT_BRIDGE_FILE],
        runAt: "document_start",
        allFrames: false,
        persistAcrossSessions: true
    }]);
    return true;
}

async function injectBridgeIntoExistingTabs(): Promise<{
    injectedTabIds: number[];
    failedTabIds: number[];
}> {
    const tabs = await chrome.tabs.query({ url: CHATGPT_ORIGIN_PATTERN });
    const injectedTabIds: number[] = [];
    const failedTabIds: number[] = [];

    for (const tab of tabs) {
        if (typeof tab.id !== "number") continue;
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id, allFrames: false },
                files: [CHATGPT_BRIDGE_FILE]
            });
            injectedTabIds.push(tab.id);
        } catch {
            // A tab can disappear or be on a restricted/transient page between
            // query and injection. Keep this explicit instead of failing the
            // entire activation after permission was already granted.
            failedTabIds.push(tab.id);
        }
    }

    return { injectedTabIds, failedTabIds };
}

/**
 * Must be called directly from a user gesture (for example a click handler).
 * chrome.permissions.request is intentionally the first asynchronous Chrome
 * operation so no preparatory await can consume the user activation.
 */
export async function enableChatGPTAccessFromUserGesture(): Promise<ChatGPTActivationResult> {
    ensureChromeActivationApis();

    const granted = await chrome.permissions.request({
        permissions: ["scripting"],
        origins: [CHATGPT_ORIGIN_PATTERN]
    });

    if (!granted) {
        return {
            granted: false,
            registered: false,
            injectedTabIds: [],
            failedTabIds: []
        };
    }

    const registered = await ensureChatGPTBridgeRegistered();
    const injection = registered
        ? await injectBridgeIntoExistingTabs()
        : { injectedTabIds: [], failedTabIds: [] };

    return {
        granted: true,
        registered,
        ...injection
    };
}

/**
 * Reconcile a previously-granted permission on extension startup/update.
 * This never displays a permission prompt.
 */
export async function reconcileChatGPTAccess(): Promise<ChatGPTActivationResult> {
    ensureChromeActivationApis();

    const granted = await hasChatGPTAccess();
    if (!granted) {
        return {
            granted: false,
            registered: false,
            injectedTabIds: [],
            failedTabIds: []
        };
    }

    const registered = await ensureChatGPTBridgeRegistered();
    return {
        granted: true,
        registered,
        injectedTabIds: [],
        failedTabIds: []
    };
}

export async function disableChatGPTAccess(options: {
    removePermission?: boolean;
} = {}): Promise<boolean> {
    ensureChromeActivationApis();

    if (await isBridgeRegistered()) {
        await chrome.scripting.unregisterContentScripts({
            ids: [CHATGPT_BRIDGE_SCRIPT_ID]
        });
    }

    if (options.removePermission) {
        return chrome.permissions.remove({
            permissions: ["scripting"],
            origins: [CHATGPT_ORIGIN_PATTERN]
        });
    }

    return true;
}
