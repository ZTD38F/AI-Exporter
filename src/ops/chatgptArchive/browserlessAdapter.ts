import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import {
    nativeConversationIdFromUrl,
    verifyDeletionManifest,
    type DeletionManifest,
    type DeleteManifestItem,
    type LiveConversationObservation
} from "./controlPlane.js";

export interface BrowserlessAccountConfig {
    accountId: string;
    endpoint: string;
    startUrl?: string;
    workspace?: string | null;
    locale?: string;
    expectedAccountIdentity?: string;
    accountIdentityProbe?: (page: Page) => Promise<string>;
    closeRemoteOnDisconnect?: boolean;
}

export interface SidebarInventoryResumeState {
    seen: Record<string, LiveConversationObservation>;
    steps: number;
    stableEndRounds: number;
}

export interface SidebarInventoryResult {
    accountId: string;
    scope: "sidebar";
    scopeComplete: boolean;
    accountInventoryComplete: false;
    items: LiveConversationObservation[];
    resumeState: SidebarInventoryResumeState;
    evidence: {
        steps: number;
        stableEndRounds: number;
        reachedScrollEnd: boolean;
        reason: "SCROLL_END_STABLE" | "MAX_STEPS" | "NO_SCROLL_CONTAINER";
    };
}

export interface DeleteDryRunReceipt {
    accountId: string;
    nativeConversationId: string;
    url: string;
    identityMatched: boolean;
    deleteControlFound: boolean;
    confirmationControlFound: boolean;
    observedTitle: string | null;
    generatedAt: string;
}

export interface MutationReceipt {
    mutationId: string;
    accountId: string;
    canonicalConversationId: string;
    nativeConversationId: string;
    manifestSha256: string;
    status: "MUTATION_SENT" | "NOT_ATTEMPTED";
    generatedAt: string;
}

const MORE_BUTTON_NAMES = /more|options|ещ[её]|vair[aā]k|darb[iī]bas/i;
const DELETE_NAMES = /delete|remove|удалить|dz[eē]st/i;
const CONFIRM_DELETE_NAMES = /delete|confirm|удалить|подтвердить|dz[eē]st|apstiprin[aā]t/i;

export function sanitizeBrowserlessEndpointForLogs(endpoint: string): string {
    try {
        const parsed = new URL(endpoint);
        parsed.username = "";
        parsed.password = "";
        for (const key of [...parsed.searchParams.keys()]) {
            if (/token|key|secret|auth|bearer|session/i.test(key)) parsed.searchParams.set(key, "<redacted>");
        }
        return parsed.toString();
    } catch {
        return "<redacted-browserless-endpoint>";
    }
}

export function emptyResumeState(): SidebarInventoryResumeState {
    return { seen: {}, steps: 0, stableEndRounds: 0 };
}

export function mergeSidebarObservation(
    state: SidebarInventoryResumeState,
    observation: LiveConversationObservation
): SidebarInventoryResumeState {
    const id = observation.nativeConversationId || nativeConversationIdFromUrl(observation.url);
    if (!id) return state;
    return {
        seen: {
            ...state.seen,
            [id]: {
                ...state.seen[id],
                ...observation,
                nativeConversationId: id
            }
        },
        steps: state.steps,
        stableEndRounds: state.stableEndRounds
    };
}

async function visibleConversationLinks(page: Page, accountId: string, workspace?: string | null): Promise<LiveConversationObservation[]> {
    const raw = await page.locator('a[href*="/c/"]').evaluateAll((anchors: HTMLAnchorElement[]) =>
        anchors.map(anchor => ({
            href: anchor.href,
            title: (anchor.textContent || "").trim()
        }))
    );
    const byId = new Map<string, LiveConversationObservation>();
    for (const item of raw) {
        const id = nativeConversationIdFromUrl(item.href);
        if (!id) continue;
        byId.set(id, {
            accountId,
            nativeConversationId: id,
            stableUrl: item.href,
            url: item.href,
            title: item.title || null,
            workspace: workspace || null,
            archiveState: "UNKNOWN"
        });
    }
    return [...byId.values()];
}

async function scrollSidebar(page: Page): Promise<{ found: boolean; atEnd: boolean }> {
    return page.evaluate(() => {
        const anchor = document.querySelector('a[href*="/c/"]') as HTMLElement | null;
        if (!anchor) return { found: false, atEnd: false };
        let node: HTMLElement | null = anchor.parentElement;
        while (node) {
            const style = getComputedStyle(node);
            const scrollable = /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight;
            if (scrollable) {
                const before = node.scrollTop;
                node.scrollTop = Math.min(node.scrollHeight, node.scrollTop + Math.max(node.clientHeight * 0.9, 400));
                const atEnd = node.scrollTop + node.clientHeight >= node.scrollHeight - 2;
                return { found: true, atEnd: atEnd || node.scrollTop === before };
            }
            node = node.parentElement;
        }
        return { found: false, atEnd: false };
    });
}

async function requireAuthenticated(page: Page): Promise<void> {
    const login = page.getByRole("link", { name: /log in|sign in|войти|piesl[eē]gties/i });
    if (await login.count()) {
        throw Object.assign(new Error("ChatGPT Browserless session requires authentication"), { code: "AUTH" });
    }
}

async function openConversationActions(page: Page): Promise<void> {
    const button = page.getByRole("button", { name: MORE_BUTTON_NAMES }).last();
    if (!await button.count()) {
        throw Object.assign(new Error("Conversation action menu was not found"), { code: "UI_DRIFT" });
    }
    await button.click();
}

async function deleteMenuControl(page: Page) {
    const menuItem = page.getByRole("menuitem", { name: DELETE_NAMES }).last();
    if (await menuItem.count()) return menuItem;
    return page.getByText(DELETE_NAMES, { exact: false }).last();
}

export class BrowserlessChatGPTAccountAdapter {
    private browser: Browser | null = null;
    private context: BrowserContext | null = null;
    private page: Page | null = null;

    constructor(readonly config: BrowserlessAccountConfig) {
        if (!config.accountId.trim()) throw new Error("accountId is required");
        if (!config.endpoint.trim()) throw new Error("Browserless endpoint is required");
    }

    async connect(): Promise<void> {
        this.browser = await chromium.connectOverCDP(this.config.endpoint);
        const contexts = this.browser.contexts();
        if (!contexts.length) {
            throw Object.assign(
                new Error("Browserless endpoint has no persistent authenticated browser context"),
                { code: "AUTH" }
            );
        }
        this.context = contexts[0];
        this.page = this.context.pages()[0] || await this.context.newPage();
    }

    async close(): Promise<void> {
        // Persistent Browserless sessions are not owned by this adapter by default.
        // Closing the remote browser can destroy authenticated session state.
        if (this.browser && this.config.closeRemoteOnDisconnect) await this.browser.close();
        this.browser = null;
        this.context = null;
        this.page = null;
    }

    private async verifyAccountBinding(page: Page): Promise<void> {
        if (!this.config.expectedAccountIdentity || !this.config.accountIdentityProbe) {
            throw Object.assign(
                new Error("Account-bound mutation requires an independent Browserless account identity probe"),
                { code: "ACCOUNT_VERIFICATION_REQUIRED" }
            );
        }
        const observed = await this.config.accountIdentityProbe(page);
        if (!observed || observed !== this.config.expectedAccountIdentity) {
            throw Object.assign(
                new Error("Browserless session is bound to a different ChatGPT account"),
                { code: "WRONG_ACCOUNT" }
            );
        }
    }

    private requirePage(): Page {
        if (!this.page) throw new Error("Browserless adapter is not connected");
        return this.page;
    }

    async inventorySidebar(
        resume: SidebarInventoryResumeState = emptyResumeState(),
        options: { maxSteps?: number; stableEndRounds?: number } = {}
    ): Promise<SidebarInventoryResult> {
        const page = this.requirePage();
        const startUrl = this.config.startUrl || "https://chatgpt.com/";
        await page.goto(startUrl, { waitUntil: "domcontentloaded" });
        await requireAuthenticated(page);

        let state: SidebarInventoryResumeState = {
            seen: { ...resume.seen },
            steps: resume.steps,
            stableEndRounds: resume.stableEndRounds
        };
        const maxSteps = options.maxSteps ?? 250;
        const requiredStableEndRounds = options.stableEndRounds ?? 3;
        let reachedScrollEnd = false;
        let reason: SidebarInventoryResult["evidence"]["reason"] = "MAX_STEPS";

        for (; state.steps < maxSteps; state.steps++) {
            const beforeCount = Object.keys(state.seen).length;
            for (const item of await visibleConversationLinks(page, this.config.accountId, this.config.workspace)) {
                state = mergeSidebarObservation(state, item);
            }
            const scroll = await scrollSidebar(page);
            if (!scroll.found) {
                reason = "NO_SCROLL_CONTAINER";
                break;
            }
            reachedScrollEnd = scroll.atEnd;
            const afterCount = Object.keys(state.seen).length;
            state.stableEndRounds = scroll.atEnd && afterCount === beforeCount
                ? state.stableEndRounds + 1
                : 0;

            if (state.stableEndRounds >= requiredStableEndRounds) {
                reason = "SCROLL_END_STABLE";
                break;
            }
            await page.waitForTimeout(150);
        }

        const scopeComplete = reason === "SCROLL_END_STABLE";
        return {
            accountId: this.config.accountId,
            scope: "sidebar",
            scopeComplete,
            // Deliberately false: sidebar traversal alone never proves account-wide completeness.
            accountInventoryComplete: false,
            items: Object.values(state.seen).sort((a, b) =>
                (a.nativeConversationId || "").localeCompare(b.nativeConversationId || "")
            ),
            resumeState: state,
            evidence: {
                steps: state.steps,
                stableEndRounds: state.stableEndRounds,
                reachedScrollEnd,
                reason
            }
        };
    }

    async dryRunDelete(item: DeleteManifestItem): Promise<DeleteDryRunReceipt> {
        if (!item.safeToDelete || item.gateResults.some(gate => !gate.passed)) {
            throw new Error("Dry-run refused: item has not passed lossless delete gates");
        }
        if (item.accountId !== this.config.accountId) {
            throw new Error("Dry-run refused: wrong account adapter");
        }

        const page = this.requirePage();
        await page.goto(item.url, { waitUntil: "domcontentloaded" });
        await requireAuthenticated(page);
        await this.verifyAccountBinding(page);
        const currentId = nativeConversationIdFromUrl(page.url());
        const identityMatched = currentId === item.nativeConversationId;
        if (!identityMatched) {
            return {
                accountId: this.config.accountId,
                nativeConversationId: item.nativeConversationId,
                url: item.url,
                identityMatched: false,
                deleteControlFound: false,
                confirmationControlFound: false,
                observedTitle: await page.title().catch(() => null),
                generatedAt: new Date().toISOString()
            };
        }

        await openConversationActions(page);
        const deleteControl = await deleteMenuControl(page);
        const deleteControlFound = Boolean(await deleteControl.count());
        // Do not click delete during dry-run. Confirmation availability cannot be truthfully proven
        // without entering mutation flow, so it remains false and actual deletion re-checks it.
        return {
            accountId: this.config.accountId,
            nativeConversationId: item.nativeConversationId,
            url: item.url,
            identityMatched,
            deleteControlFound,
            confirmationControlFound: false,
            observedTitle: await page.title().catch(() => null),
            generatedAt: new Date().toISOString()
        };
    }

    async deleteAuthorizedConversation(input: {
        manifest: DeletionManifest;
        item: DeleteManifestItem;
        dryRun: DeleteDryRunReceipt;
        mutationId: string;
    }): Promise<MutationReceipt> {
        const { manifest, item, dryRun } = input;
        if (!verifyDeletionManifest(manifest)) throw new Error("Deletion refused: manifest hash or gates are invalid");
        const manifestItem = manifest.items.find(candidate =>
            candidate.accountId === item.accountId
            && candidate.canonicalConversationId === item.canonicalConversationId
            && candidate.nativeConversationId === item.nativeConversationId
        );
        if (!manifestItem || !manifestItem.safeToDelete) throw new Error("Deletion refused: item not authorized by manifest");
        if (item.accountId !== this.config.accountId) throw new Error("Deletion refused: wrong account adapter");
        if (!dryRun.identityMatched || !dryRun.deleteControlFound || dryRun.nativeConversationId !== item.nativeConversationId) {
            throw new Error("Deletion refused: dry-run identity/control proof is insufficient");
        }

        const page = this.requirePage();
        await page.goto(item.url, { waitUntil: "domcontentloaded" });
        await requireAuthenticated(page);
        await this.verifyAccountBinding(page);
        if (nativeConversationIdFromUrl(page.url()) !== item.nativeConversationId) {
            throw Object.assign(new Error("Deletion refused: conversation identity changed before mutation"), { code: "IDENTITY" });
        }

        await openConversationActions(page);
        const deleteControl = await deleteMenuControl(page);
        if (!await deleteControl.count()) throw Object.assign(new Error("Delete control disappeared before mutation"), { code: "UI_DRIFT" });
        await deleteControl.click();

        const confirm = page.getByRole("button", { name: CONFIRM_DELETE_NAMES }).last();
        if (!await confirm.count()) {
            throw Object.assign(new Error("Delete confirmation control was not found"), { code: "UI_DRIFT" });
        }
        await confirm.click();

        return {
            mutationId: input.mutationId,
            accountId: item.accountId,
            canonicalConversationId: item.canonicalConversationId,
            nativeConversationId: item.nativeConversationId,
            manifestSha256: manifest.manifestSha256,
            // Mutation receipt does NOT claim deletion verification. Post-delete inventory must do that.
            status: "MUTATION_SENT",
            generatedAt: new Date().toISOString()
        };
    }
}
