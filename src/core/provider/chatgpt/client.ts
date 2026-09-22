import { ChatGPTTransport } from "./transport.js";

function requireIdentifier(value: string, label: string): string {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
        throw new Error(`Invalid ${label}`);
    }
    return value;
}

function query(params: Record<string, string | number | boolean | null | undefined>): string {
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === null || value === undefined) continue;
        q.set(key, String(value));
    }
    return q.toString();
}

/**
 * Typed read-only facade over ChatGPTTransport.
 *
 * Endpoint knowledge lives here; pagination/inventory code never constructs
 * arbitrary backend paths itself.
 */
export class ChatGPTClient {
    constructor(private readonly transport: ChatGPTTransport) {}

    accounts(): Promise<any> {
        return this.transport.requestJson("/backend-api/accounts/check/v4-2023-04-27");
    }

    conversationPage(offset: number, limit: number, archived: boolean, workspaceId: string): Promise<any> {
        return this.transport.requestJson(
            `/backend-api/conversations?${query({
                offset,
                limit,
                order: "updated",
                is_archived: archived ? "true" : null
            })}`,
            workspaceId
        );
    }

    projectsPage(cursor: string | null, workspaceId: string): Promise<any> {
        return this.transport.requestJson(
            `/backend-api/gizmos/snorlax/sidebar?${query({
                conversations_per_gizmo: 0,
                cursor
            })}`,
            workspaceId
        );
    }

    projectConversations(projectId: string, cursor: string, workspaceId: string): Promise<any> {
        const pid = requireIdentifier(projectId, "project id");
        return this.transport.requestJson(
            `/backend-api/gizmos/${pid}/conversations?${query({ cursor })}`,
            workspaceId
        );
    }

    sharedPage(offset: number, limit: number, workspaceId: string): Promise<any> {
        return this.transport.requestJson(
            `/backend-api/shared_conversations?${query({ order: "updated", limit, offset })}`,
            workspaceId
        );
    }

    conversationDetail(conversationId: string, workspaceId: string): Promise<any> {
        const cid = requireIdentifier(conversationId, "conversation id");
        return this.transport.requestJson(`/backend-api/conversation/${cid}`, workspaceId);
    }

    sharedDetail(shareId: string, workspaceId: string): Promise<any> {
        const sid = requireIdentifier(shareId, "share id");
        return this.transport.requestJson(`/backend-api/share/${sid}`, workspaceId);
    }

    async resolveFile(
        fileId: string,
        workspaceId: string,
        context: { conversationId?: string; projectId?: string }
    ): Promise<any> {
        const fid = requireIdentifier(fileId, "file id");
        const hasConversation = typeof context?.conversationId === "string" && !!context.conversationId;
        const hasProject = typeof context?.projectId === "string" && !!context.projectId;
        if (hasConversation === hasProject) {
            throw new Error("Exactly one conversationId or projectId is required");
        }

        if (hasConversation) {
            const cid = requireIdentifier(context.conversationId!, "conversation id");
            return this.transport.requestJson(
                `/backend-api/files/download/${fid}?${query({
                    conversation_id: cid,
                    inline: "false"
                })}`,
                workspaceId
            );
        }

        const projectId = requireIdentifier(context.projectId!, "project id");
        const qs = query({ gizmo_id: projectId });
        try {
            return await this.transport.requestJson(
                `/backend-api/files/download/${fid}?${qs}`,
                workspaceId
            );
        } catch (error: any) {
            if (error?.status !== 404 && error?.status !== 405) throw error;
            return this.transport.requestJson(
                `/backend-api/files/${fid}/download?${qs}`,
                workspaceId
            );
        }
    }

    accountArtifact(kind: "memories" | "custom_instructions" | "settings" | "beta_features", workspaceId: string): Promise<any> {
        const paths = {
            memories: "/backend-api/memories?include_memory_entries=true",
            custom_instructions: "/backend-api/user_system_messages",
            settings: "/backend-api/settings",
            beta_features: "/backend-api/settings/beta_features"
        } as const;
        return this.transport.requestJson(paths[kind], workspaceId);
    }

    myGptsPage(cursor: string | null, workspaceId: string): Promise<any> {
        return this.transport.requestJson(
            `/public-api/gizmos/discovery/mine?${query({ limit: 20, cursor })}`,
            workspaceId
        );
    }
}

export default ChatGPTClient;
