import type { ChatMessage, Attachment } from "../../../types/conversation.js";
import type { ProviderConversationDetail } from "../aiProvider.js";

export type ChatGPTActivePathStopReason =
    | "root_reached"
    | "empty_mapping"
    | "missing_current_node"
    | "unknown_current_node"
    | "missing_parent"
    | "parent_cycle";

export interface ChatGPTGraphNodeSummary {
    nodeId: string;
    parentId: string | null;
    childIds: string[];
    hasMessage: boolean;
    messageId?: string;
    providerRole?: string;
    contentType?: string;
}

export interface ChatGPTGraphDiagnostics {
    totalNodes: number;
    messageNodes: number;
    rootNodeIds: string[];
    currentNodeId: string | null;
    activePathNodeIds: string[];
    activePathComplete: boolean;
    activePathStopReason: ChatGPTActivePathStopReason;
    branchPointNodeIds: string[];
    alternateMessageNodeIds: string[];
    orphanParentNodeIds: string[];
    danglingChildRefs: Array<{ parentNodeId: string; childNodeId: string }>;
    cycleNodeIds: string[];
    malformedNodeIds: string[];
    observedContentTypes: Record<string, number>;
    observedProviderRoles: Record<string, number>;
    unparsedContentParts: number;
    normalizationComplete: boolean;
}

export interface ChatGPTNormalizedConversation extends ProviderConversationDetail {
    providerId: "chatgpt";
    graph: ChatGPTGraphDiagnostics;
    branchIndex: ChatGPTGraphNodeSummary[];
    raw: any;
}

function objectRecord(value: any): Record<string, any> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function toTimestampMs(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
    return value < 1_000_000_000_000 ? Math.round(value * 1000) : Math.round(value);
}

function providerRole(message: any): string {
    const value = message?.author?.role;
    return typeof value === "string" && value ? value : "unknown";
}

function normalizedRole(rawRole: string): ChatMessage["role"] {
    if (rawRole === "user") return "user";
    if (rawRole === "assistant") return "model";
    if (rawRole === "system") return "system";
    // Tool and future provider-specific roles must remain visible through
    // providerRole while using a safe neutral role in the shared formatter.
    return "system";
}

function contentType(message: any): string {
    const content = message?.content;
    if (content && typeof content === "object" && typeof content.content_type === "string") {
        return content.content_type;
    }
    if (typeof content === "string") return "text";
    return "unknown";
}

function textFromUnknown(value: any): string[] {
    if (typeof value === "string") return value ? [value] : [];
    if (!value || typeof value !== "object") return [];

    const out: string[] = [];
    if (typeof value.text === "string" && value.text) out.push(value.text);
    if (typeof value.content === "string" && value.content) out.push(value.content);
    return out;
}

function extractNormalizedMessage(nodeId: string, node: any): {
    message: ChatMessage | null;
    unparsedParts: number;
} {
    const rawMessage = objectRecord(node?.message);
    if (!rawMessage) return { message: null, unparsedParts: 0 };

    const rawRole = providerRole(rawMessage);
    const rawContent = rawMessage.content;
    const texts: string[] = [];
    const attachments: Attachment[] = [];
    const thoughts: string[] = [];
    let unparsedParts = 0;

    if (typeof rawContent === "string") {
        if (rawContent) texts.push(rawContent);
    } else if (rawContent && typeof rawContent === "object") {
        if (Array.isArray(rawContent.parts)) {
            for (const part of rawContent.parts) {
                if (typeof part === "string") {
                    if (part) texts.push(part);
                    continue;
                }
                if (!part || typeof part !== "object") {
                    unparsedParts++;
                    continue;
                }

                const pointer = typeof part.asset_pointer === "string" ? part.asset_pointer : "";
                const partType = typeof part.content_type === "string" ? part.content_type : "";
                if (pointer) {
                    attachments.push({
                        type: partType === "image_asset_pointer" ? "image" : "file",
                        provider: "chatgpt",
                        assetPointer: pointer,
                        fileName: typeof part.name === "string"
                            ? part.name
                            : typeof part.file_name === "string"
                                ? part.file_name
                                : undefined
                    });
                }

                const partTexts = textFromUnknown(part);
                if (partTexts.length) {
                    texts.push(...partTexts);
                } else if (!pointer) {
                    unparsedParts++;
                }
            }
        } else if (typeof rawContent.text === "string") {
            if (rawContent.text) texts.push(rawContent.text);
        } else {
            const direct = textFromUnknown(rawContent);
            if (direct.length) texts.push(...direct);
            else if (Object.keys(rawContent).length) unparsedParts++;
        }
    } else if (rawContent !== null && rawContent !== undefined) {
        unparsedParts++;
    }

    const metadata = objectRecord(rawMessage.metadata);
    const metadataAttachments = metadata && Array.isArray(metadata.attachments)
        ? metadata.attachments
        : [];
    for (const item of metadataAttachments) {
        if (!item || typeof item !== "object") continue;
        const fileId = typeof item.id === "string"
            ? item.id
            : typeof item.file_id === "string"
                ? item.file_id
                : undefined;
        const name = typeof item.name === "string"
            ? item.name
            : typeof item.file_name === "string"
                ? item.file_name
                : undefined;
        if (!fileId && !name) continue;
        attachments.push({
            type: typeof item.mime_type === "string" && item.mime_type.startsWith("image/") ? "image" : "file",
            provider: "chatgpt",
            fileId,
            fileName: name,
            mimeType: typeof item.mime_type === "string" ? item.mime_type : undefined
        });
    }

    const thought = metadata?.thought;
    if (typeof thought === "string" && thought) {
        thoughts.push(thought);
    } else if (Array.isArray(thought)) {
        for (const entry of thought) {
            if (typeof entry === "string" && entry) thoughts.push(entry);
        }
    }

    const type = contentType(rawMessage);
    if ((type === "thought" || type === "reasoning_recap") && texts.length) {
        thoughts.push(texts.join("\n"));
        texts.length = 0;
    }

    const message: ChatMessage = {
        role: normalizedRole(rawRole),
        content: texts.join("\n"),
        timestamp: toTimestampMs(rawMessage.create_time),
        turnId: typeof rawMessage.id === "string" ? rawMessage.id : nodeId,
        provider: "chatgpt",
        providerRole: rawRole,
        nodeId,
        parentNodeId: typeof node.parent === "string" ? node.parent : null,
        contentType: type,
        attachments: attachments.length ? attachments : undefined,
        thoughts: thoughts.length ? thoughts : undefined,
        unparsedContentParts: unparsedParts || undefined
    };

    return { message, unparsedParts };
}

function findChildCycles(mapping: Record<string, any>): string[] {
    const color = new Map<string, 0 | 1 | 2>();
    const inCycle = new Set<string>();

    const visit = (id: string, stack: string[]): void => {
        const state = color.get(id) || 0;
        if (state === 2) return;
        if (state === 1) {
            const index = stack.indexOf(id);
            for (const cycleId of index >= 0 ? stack.slice(index) : [id]) inCycle.add(cycleId);
            return;
        }

        color.set(id, 1);
        const node = objectRecord(mapping[id]);
        const children = node && Array.isArray(node.children)
            ? node.children.filter((child: any) => typeof child === "string")
            : [];
        for (const child of children) {
            if (mapping[child]) visit(child, [...stack, id]);
        }
        color.set(id, 2);
    };

    for (const id of Object.keys(mapping)) visit(id, []);
    return [...inCycle].sort();
}

function buildActivePath(mapping: Record<string, any>, currentNodeId: string | null): {
    nodeIds: string[];
    complete: boolean;
    reason: ChatGPTActivePathStopReason;
} {
    const ids = Object.keys(mapping);
    if (!ids.length) {
        return { nodeIds: [], complete: false, reason: "empty_mapping" };
    }
    if (!currentNodeId) {
        return { nodeIds: [], complete: false, reason: "missing_current_node" };
    }
    if (!mapping[currentNodeId]) {
        return { nodeIds: [], complete: false, reason: "unknown_current_node" };
    }

    const reversed: string[] = [];
    const seen = new Set<string>();
    let cursor: string | null = currentNodeId;

    while (cursor) {
        if (seen.has(cursor)) {
            return {
                nodeIds: [...reversed].reverse(),
                complete: false,
                reason: "parent_cycle"
            };
        }
        seen.add(cursor);

        const node = objectRecord(mapping[cursor]);
        if (!node) {
            return {
                nodeIds: [...reversed].reverse(),
                complete: false,
                reason: "missing_parent"
            };
        }
        reversed.push(cursor);

        const parent = typeof node.parent === "string" && node.parent ? node.parent : null;
        if (!parent) {
            return {
                nodeIds: reversed.reverse(),
                complete: true,
                reason: "root_reached"
            };
        }
        if (!mapping[parent]) {
            return {
                nodeIds: reversed.reverse(),
                complete: false,
                reason: "missing_parent"
            };
        }
        cursor = parent;
    }

    return {
        nodeIds: reversed.reverse(),
        complete: true,
        reason: "root_reached"
    };
}

export function analyzeChatGPTGraph(raw: any): {
    diagnostics: ChatGPTGraphDiagnostics;
    branchIndex: ChatGPTGraphNodeSummary[];
    activeMessages: ChatMessage[];
} {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("Invalid ChatGPT conversation payload");
    }

    const mapping = objectRecord(raw.mapping) || {};
    const currentNodeId = typeof raw.current_node === "string" && raw.current_node
        ? raw.current_node
        : null;

    const rootNodeIds: string[] = [];
    const branchPointNodeIds: string[] = [];
    const orphanParentNodeIds: string[] = [];
    const danglingChildRefs: Array<{ parentNodeId: string; childNodeId: string }> = [];
    const observedContentTypes: Record<string, number> = {};
    const observedProviderRoles: Record<string, number> = {};
    const branchIndex: ChatGPTGraphNodeSummary[] = [];
    const malformedNodeIds: string[] = [];
    let messageNodes = 0;

    for (const [nodeId, rawNode] of Object.entries(mapping)) {
        const node = objectRecord(rawNode);
        if (!node) {
            malformedNodeIds.push(nodeId);
            continue;
        }

        const parentId = typeof node.parent === "string" && node.parent ? node.parent : null;
        const childIds = Array.isArray(node.children)
            ? node.children.filter((value: any): value is string => typeof value === "string")
            : [];
        if (!parentId) rootNodeIds.push(nodeId);
        else if (!mapping[parentId]) orphanParentNodeIds.push(nodeId);

        if (childIds.length > 1) branchPointNodeIds.push(nodeId);
        for (const childId of childIds) {
            if (!mapping[childId]) danglingChildRefs.push({ parentNodeId: nodeId, childNodeId: childId });
        }

        const message = objectRecord(node.message);
        const role = message ? providerRole(message) : undefined;
        const type = message ? contentType(message) : undefined;
        if (message) {
            messageNodes++;
            observedProviderRoles[role!] = (observedProviderRoles[role!] || 0) + 1;
            observedContentTypes[type!] = (observedContentTypes[type!] || 0) + 1;
        }

        branchIndex.push({
            nodeId,
            parentId,
            childIds,
            hasMessage: !!message,
            messageId: typeof message?.id === "string" ? message.id : undefined,
            providerRole: role,
            contentType: type
        });
    }

    rootNodeIds.sort();
    branchPointNodeIds.sort();
    orphanParentNodeIds.sort();
    malformedNodeIds.sort();
    branchIndex.sort((a, b) => a.nodeId.localeCompare(b.nodeId));

    const active = buildActivePath(mapping, currentNodeId);
    const activeSet = new Set(active.nodeIds);
    const activeMessages: ChatMessage[] = [];
    let unparsedContentParts = 0;

    for (const nodeId of active.nodeIds) {
        const node = objectRecord(mapping[nodeId]);
        if (!node) continue;
        const normalized = extractNormalizedMessage(nodeId, node);
        unparsedContentParts += normalized.unparsedParts;
        if (normalized.message) activeMessages.push(normalized.message);
    }

    // Count unparsed content in non-active message nodes too; otherwise a clean
    // active branch could hide provider drift in an alternate regeneration.
    for (const [nodeId, rawNode] of Object.entries(mapping)) {
        if (activeSet.has(nodeId)) continue;
        const node = objectRecord(rawNode);
        if (!node?.message) continue;
        unparsedContentParts += extractNormalizedMessage(nodeId, node).unparsedParts;
    }

    const alternateMessageNodeIds = branchIndex
        .filter(node => node.hasMessage && !activeSet.has(node.nodeId))
        .map(node => node.nodeId);

    const cycleNodeIds = findChildCycles(mapping);
    const normalizationComplete =
        active.complete
        && orphanParentNodeIds.length === 0
        && danglingChildRefs.length === 0
        && cycleNodeIds.length === 0
        && malformedNodeIds.length === 0
        && unparsedContentParts === 0;

    return {
        diagnostics: {
            totalNodes: Object.keys(mapping).length,
            messageNodes,
            rootNodeIds,
            currentNodeId,
            activePathNodeIds: active.nodeIds,
            activePathComplete: active.complete,
            activePathStopReason: active.reason,
            branchPointNodeIds,
            alternateMessageNodeIds,
            orphanParentNodeIds,
            danglingChildRefs,
            cycleNodeIds,
            malformedNodeIds,
            observedContentTypes,
            observedProviderRoles,
            unparsedContentParts,
            normalizationComplete
        },
        branchIndex,
        activeMessages
    };
}

export function normalizeChatGPTConversation(
    raw: any,
    conversationId?: string,
    workspaceKey: string = "chatgpt"
): ChatGPTNormalizedConversation {
    const analyzed = analyzeChatGPTGraph(raw);
    const id = typeof conversationId === "string" && conversationId
        ? conversationId
        : typeof raw?.id === "string" && raw.id
            ? raw.id
            : typeof raw?.conversation_id === "string" && raw.conversation_id
                ? raw.conversation_id
                : "unknown";

    const title = typeof raw?.title === "string" && raw.title.trim()
        ? raw.title.trim()
        : "Untitled ChatGPT Conversation";

    const createdAt = toTimestampMs(raw?.create_time)
        ?? analyzed.activeMessages.find(message => message.timestamp)?.timestamp
        ?? null;
    const updatedAt = toTimestampMs(raw?.update_time)
        ?? [...analyzed.activeMessages].reverse().find(message => message.timestamp)?.timestamp
        ?? createdAt;

    return {
        providerId: "chatgpt",
        scopeKey: workspaceKey,
        id,
        title,
        titleSource: "api-detail",
        titles: { "api-detail": title },
        messages: analyzed.activeMessages,
        createdAt,
        chatTime: updatedAt,
        timestamp: updatedAt,
        updatedAt,
        url: id !== "unknown" ? `https://chatgpt.com/c/${id}` : undefined,
        graph: analyzed.diagnostics,
        branchIndex: analyzed.branchIndex,
        raw,
        integrity: {
            state: analyzed.diagnostics.normalizationComplete ? "NORMALIZED" : "PARTIAL",
            complete: analyzed.diagnostics.normalizationComplete,
            reasons: analyzed.diagnostics.normalizationComplete
                ? []
                : [
                    !analyzed.diagnostics.activePathComplete ? `active_path:${analyzed.diagnostics.activePathStopReason}` : "",
                    analyzed.diagnostics.orphanParentNodeIds.length ? "orphan_parent" : "",
                    analyzed.diagnostics.danglingChildRefs.length ? "dangling_child" : "",
                    analyzed.diagnostics.cycleNodeIds.length ? "graph_cycle" : "",
                    analyzed.diagnostics.malformedNodeIds.length ? "malformed_node" : "",
                    analyzed.diagnostics.unparsedContentParts ? "unparsed_content" : ""
                ].filter(Boolean)
        }
    };
}
