import ChatGPTClient from "./client.js";
import { ChatGPTTransportError } from "./transport.js";

export class ChatGPTInventoryError extends Error {
    readonly code: string;
    readonly scope?: string;

    constructor(code: string, message: string, scope?: string) {
        super(message);
        this.name = "ChatGPTInventoryError";
        this.code = code;
        this.scope = scope;
    }
}

export interface PaginationEvidence {
    kind: "offset" | "cursor";
    scope: string;
    complete: boolean;
    pagesFetched: number;
    itemsSeen: number;
    uniqueItems: number;
    stopReason:
        | "total_reached"
        | "empty_page"
        | "cursor_exhausted"
        | "repeated_page"
        | "premature_empty"
        | "offset_stall"
        | "cursor_cycle"
        | "page_limit"
        | "contract_drift";
    serverTotal?: number | null;
    finalOffset?: number;
    finalCursor?: string | null;
}

export interface ChainResult {
    items: any[];
    evidence: PaginationEvidence;
}

export interface ChatGPTInventoryResult {
    schemaVersion: 1;
    providerId: "chatgpt";
    workspaceKey: string;
    conversationInventoryComplete: boolean;
    listings: Record<string, any>;
    memberships: Record<string, Array<Record<string, any>>>;
    projects: Record<string, {
        id: string;
        name: string;
        raw: any;
        files: any[];
    }>;
    shares: Record<string, any>;
    evidence: PaginationEvidence[];
    errors: Array<{
        scope: string;
        code: string;
        message: string;
    }>;
}

export interface InventoryOptions {
    pageSize?: number;
    maxPages?: number;
    signal?: AbortSignal | null;
    onProgress?: (info: {
        scope: string;
        page: number;
        uniqueItems: number;
    }) => void;
}

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 10_000;

function positiveInt(value: unknown, fallback: number, max: number): number {
    return typeof value === "number" && Number.isInteger(value) && value > 0
        ? Math.min(value, max)
        : fallback;
}

function requiredId(item: any, label: string): string {
    const value = item?.id;
    if (typeof value !== "string" || !value) {
        throw new ChatGPTInventoryError("CONTRACT_DRIFT", `${label} item missing id`);
    }
    return value;
}

function pageItems(raw: any, label: string): any[] {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.items)) {
        throw new ChatGPTInventoryError("CONTRACT_DRIFT", `${label} page no longer contains items[]`);
    }
    return raw.items.filter((item: any) => item && typeof item === "object");
}

function cursorEnvelope(raw: any): { items: any[]; next: string | null } {
    if (!raw || typeof raw !== "object") {
        throw new ChatGPTInventoryError("CONTRACT_DRIFT", "cursor inventory returned a non-object");
    }
    const nested = raw.list && typeof raw.list === "object" ? raw.list : null;
    const rawItems = Array.isArray(raw.items)
        ? raw.items
        : nested && Array.isArray(nested.items)
            ? nested.items
            : null;
    if (!rawItems) {
        throw new ChatGPTInventoryError("CONTRACT_DRIFT", "cursor inventory no longer contains items[]");
    }
    const nextRaw = raw.cursor !== undefined
        ? raw.cursor
        : nested?.cursor !== undefined
            ? nested.cursor
            : raw.next_cursor;
    if (nextRaw === null || nextRaw === undefined || nextRaw === "") {
        return {
            items: rawItems.filter((item: any) => item && typeof item === "object"),
            next: null
        };
    }
    if (typeof nextRaw !== "string") {
        throw new ChatGPTInventoryError("CONTRACT_DRIFT", "cursor inventory returned a non-string cursor");
    }
    return {
        items: rawItems.filter((item: any) => item && typeof item === "object"),
        next: nextRaw
    };
}

function abortIfNeeded(signal?: AbortSignal | null): void {
    if (signal?.aborted) {
        throw new ChatGPTInventoryError("ABORTED", "ChatGPT inventory was aborted");
    }
}

export async function offsetChain(
    fetchPage: (offset: number, limit: number) => Promise<any>,
    scope: string,
    options: InventoryOptions = {}
): Promise<ChainResult> {
    const pageSize = positiveInt(options.pageSize, DEFAULT_PAGE_SIZE, 100);
    const maxPages = positiveInt(options.maxPages, DEFAULT_MAX_PAGES, 100_000);
    const items: any[] = [];
    const seenIds = new Set<string>();
    const seenPages = new Set<string>();
    let offset = 0;
    let itemsSeen = 0;

    for (let page = 1; page <= maxPages; page++) {
        abortIfNeeded(options.signal);
        const raw = await fetchPage(offset, pageSize);
        const batch = pageItems(raw, scope);
        const ids = batch.map(item => requiredId(item, scope));
        const signature = JSON.stringify(ids);
        const serverTotal = Number.isInteger(raw.total) && raw.total >= 0 ? raw.total : null;

        if (ids.length && seenPages.has(signature)) {
            throw new ChatGPTInventoryError(
                "INVENTORY_REPEATED_PAGE",
                `${scope} inventory repeated at offset ${offset}`,
                scope
            );
        }
        seenPages.add(signature);

        itemsSeen += batch.length;
        for (let i = 0; i < batch.length; i++) {
            const id = ids[i];
            if (seenIds.has(id)) continue;
            seenIds.add(id);
            items.push(batch[i]);
        }

        options.onProgress?.({ scope, page, uniqueItems: items.length });

        const nextOffset = offset + batch.length;

        if (!batch.length) {
            if (serverTotal !== null && offset < serverTotal) {
                throw new ChatGPTInventoryError(
                    "INVENTORY_PREMATURE_EMPTY_PAGE",
                    `${scope} ended at offset ${offset} before server total ${serverTotal}`,
                    scope
                );
            }
            return {
                items,
                evidence: {
                    kind: "offset",
                    scope,
                    complete: true,
                    pagesFetched: page,
                    itemsSeen,
                    uniqueItems: items.length,
                    stopReason: "empty_page",
                    serverTotal,
                    finalOffset: offset
                }
            };
        }

        if (serverTotal !== null && nextOffset >= serverTotal) {
            return {
                items,
                evidence: {
                    kind: "offset",
                    scope,
                    complete: true,
                    pagesFetched: page,
                    itemsSeen,
                    uniqueItems: items.length,
                    stopReason: "total_reached",
                    serverTotal,
                    finalOffset: nextOffset
                }
            };
        }

        if (nextOffset <= offset) {
            throw new ChatGPTInventoryError(
                "INVENTORY_OFFSET_STALL",
                `${scope} offset stalled at ${offset}`,
                scope
            );
        }
        offset = nextOffset;
    }

    throw new ChatGPTInventoryError(
        "INVENTORY_PAGE_LIMIT",
        `${scope} exceeded page safety limit ${maxPages}`,
        scope
    );
}

export async function cursorChain(
    fetchPage: (cursor: string | null) => Promise<any>,
    scope: string,
    firstCursor: string | null,
    options: InventoryOptions = {}
): Promise<ChainResult> {
    const maxPages = positiveInt(options.maxPages, DEFAULT_MAX_PAGES, 100_000);
    const items: any[] = [];
    const seenIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor = firstCursor;
    let itemsSeen = 0;

    for (let page = 1; page <= maxPages; page++) {
        abortIfNeeded(options.signal);
        const raw = await fetchPage(cursor);
        const envelope = cursorEnvelope(raw);
        itemsSeen += envelope.items.length;

        for (const item of envelope.items) {
            let id: string;
            if (typeof item.id === "string" && item.id) {
                id = item.id;
            } else {
                // Preserve distinct unknown objects without pretending this is a
                // stable provider identifier. JSON identity is enough for
                // same-run de-duplication; contract validation happens later.
                id = `synthetic:${JSON.stringify(item)}`;
            }
            if (seenIds.has(id)) continue;
            seenIds.add(id);
            items.push(item);
        }

        options.onProgress?.({ scope, page, uniqueItems: items.length });

        if (envelope.next === null) {
            return {
                items,
                evidence: {
                    kind: "cursor",
                    scope,
                    complete: true,
                    pagesFetched: page,
                    itemsSeen,
                    uniqueItems: items.length,
                    stopReason: "cursor_exhausted",
                    finalCursor: null
                }
            };
        }

        if (envelope.next === cursor || seenCursors.has(envelope.next)) {
            throw new ChatGPTInventoryError(
                "INVENTORY_CURSOR_CYCLE",
                `${scope} cursor chain repeated`,
                scope
            );
        }
        seenCursors.add(envelope.next);
        cursor = envelope.next;
    }

    throw new ChatGPTInventoryError(
        "INVENTORY_PAGE_LIMIT",
        `${scope} exceeded page safety limit ${maxPages}`,
        scope
    );
}

function parseProject(item: any): { id: string; name: string; files: any[] } | null {
    if (!item || typeof item !== "object") return null;
    let wrapper = item.resource && typeof item.resource === "object" ? item.resource : item;
    wrapper = wrapper.gizmo && typeof wrapper.gizmo === "object" ? wrapper.gizmo : wrapper;
    const files = Array.isArray(wrapper.files) ? wrapper.files.filter((file: any) => file && typeof file === "object") : [];
    const gizmo = wrapper.gizmo && typeof wrapper.gizmo === "object" ? wrapper.gizmo : wrapper;
    const id = typeof gizmo?.id === "string" ? gizmo.id : "";
    if (!id) return null;
    const display = gizmo.display && typeof gizmo.display === "object" ? gizmo.display : {};
    const rawName = typeof display.name === "string" ? display.name : gizmo.name;
    return {
        id,
        name: typeof rawName === "string" && rawName.trim() ? rawName.trim() : id,
        files
    };
}

function addMembership(
    memberships: Record<string, Array<Record<string, any>>>,
    conversationId: string,
    membership: Record<string, any>
): void {
    const list = memberships[conversationId] || (memberships[conversationId] = []);
    const signature = JSON.stringify(membership);
    if (!list.some(existing => JSON.stringify(existing) === signature)) {
        list.push(membership);
    }
}

function safeInventoryError(scope: string, error: any): { scope: string; code: string; message: string } {
    return {
        scope,
        code: typeof error?.code === "string" ? error.code : "INVENTORY_FAILED",
        message: typeof error?.message === "string" ? error.message.slice(0, 1000) : "Inventory failed"
    };
}

function mustRethrow(error: any): boolean {
    return error instanceof ChatGPTTransportError && error.code === "AUTH_REQUIRED"
        || error instanceof ChatGPTInventoryError && error.code === "ABORTED";
}

export async function captureChatGPTInventory(
    client: ChatGPTClient,
    workspaceId: string,
    workspaceKey: string,
    options: InventoryOptions = {}
): Promise<ChatGPTInventoryResult> {
    const listings: Record<string, any> = {};
    const memberships: Record<string, Array<Record<string, any>>> = {};
    const projects: ChatGPTInventoryResult["projects"] = {};
    const shares: Record<string, any> = {};
    const evidence: PaginationEvidence[] = [];
    const errors: ChatGPTInventoryResult["errors"] = [];

    for (const archived of [false, true]) {
        const scope = archived ? "archived" : "main";
        try {
            const result = await offsetChain(
                (offset, limit) => client.conversationPage(offset, limit, archived, workspaceId),
                scope,
                options
            );
            evidence.push(result.evidence);
            for (const item of result.items) {
                const id = requiredId(item, "conversation");
                listings[id] = item;
                addMembership(memberships, id, { scope });
            }
        } catch (error: any) {
            if (mustRethrow(error)) throw error;
            errors.push(safeInventoryError(scope, error));
        }
    }

    try {
        const projectResult = await cursorChain(
            cursor => client.projectsPage(cursor, workspaceId),
            "projects",
            null,
            options
        );
        evidence.push(projectResult.evidence);

        for (const raw of projectResult.items) {
            const project = parseProject(raw);
            if (!project) {
                errors.push({
                    scope: "projects",
                    code: "PROJECT_CONTRACT_DRIFT",
                    message: "Project inventory item could not be assigned a stable project id"
                });
                continue;
            }

            projects[project.id] = {
                id: project.id,
                name: project.name,
                raw,
                files: project.files
            };

            const scope = `project:${project.id}`;
            try {
                const conversations = await cursorChain(
                    cursor => client.projectConversations(project.id, cursor || "0", workspaceId),
                    scope,
                    "0",
                    options
                );
                evidence.push(conversations.evidence);
                for (const item of conversations.items) {
                    const id = requiredId(item, "conversation");
                    if (!listings[id]) listings[id] = item;
                    addMembership(memberships, id, {
                        scope: "project",
                        projectId: project.id,
                        projectName: project.name
                    });
                }
            } catch (error: any) {
                if (mustRethrow(error)) throw error;
                errors.push(safeInventoryError(scope, error));
            }
        }
    } catch (error: any) {
        if (mustRethrow(error)) throw error;
        errors.push(safeInventoryError("projects", error));
    }

    try {
        const sharedResult = await offsetChain(
            (offset, limit) => client.sharedPage(offset, limit, workspaceId),
            "shared",
            options
        );
        evidence.push(sharedResult.evidence);
        for (const item of sharedResult.items) {
            const shareId = requiredId(item, "share");
            shares[shareId] = item;
            const conversationId = typeof item.conversation_id === "string" ? item.conversation_id : "";
            if (!conversationId) continue;
            if (!listings[conversationId]) listings[conversationId] = item;
            addMembership(memberships, conversationId, {
                scope: "shared",
                shareId
            });
        }
    } catch (error: any) {
        if (mustRethrow(error)) throw error;
        errors.push(safeInventoryError("shared", error));
    }

    return {
        schemaVersion: 1,
        providerId: "chatgpt",
        workspaceKey,
        conversationInventoryComplete: errors.length === 0 && evidence.length >= 4 && evidence.every(item => item.complete),
        listings,
        memberships,
        projects,
        shares,
        evidence,
        errors
    };
}
