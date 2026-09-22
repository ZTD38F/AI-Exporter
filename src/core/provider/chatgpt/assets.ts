import ChatGPTClient from "./client.js";

export interface ChatGPTAssetReference {
    fileId: string;
    preferredName: string;
    mimeType?: string;
    sources: Array<"asset_pointer" | "attachment" | "citation" | "file_id" | "gpt_file">;
}

export interface ChatGPTAssetResolution {
    fileId: string;
    preferredName: string;
    /**
     * Sensitive and ephemeral. Use immediately for download and NEVER persist.
     */
    signedUrl: string;
    redactedResolverMetadata: any;
}

const SIGNED_URL_KEY_PRIORITY = [
    "download_url",
    "presigned_url",
    "signed_url",
    "file_url",
    "url"
] as const;
const SIGNED_URL_KEYS = new Set<string>(SIGNED_URL_KEY_PRIORITY);

function safeName(value: any, fallback: string): string {
    if (typeof value !== "string" || !value.trim()) return fallback;
    return value.trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 240) || fallback;
}

function addRef(
    refs: Map<string, ChatGPTAssetReference>,
    fileId: any,
    name: any,
    source: ChatGPTAssetReference["sources"][number],
    mimeType?: any
): void {
    if (typeof fileId !== "string" || !/^[A-Za-z0-9_-]+$/.test(fileId)) return;
    const existing = refs.get(fileId);
    const preferredName = safeName(name, fileId);
    if (existing) {
        if (!existing.sources.includes(source)) existing.sources.push(source);
        const existingGeneric = existing.preferredName === existing.fileId
            || existing.preferredName === "image"
            || existing.preferredName === "citation";
        const candidateGeneric = preferredName === fileId
            || preferredName === "image"
            || preferredName === "citation";
        if (existingGeneric && !candidateGeneric) {
            existing.preferredName = preferredName;
        }
        const existingIsMime = typeof existing.mimeType === "string" && /^[^/\s]+\/[^/\s]+$/.test(existing.mimeType);
        const candidateIsMime = typeof mimeType === "string" && /^[^/\s]+\/[^/\s]+$/.test(mimeType);
        if ((!existing.mimeType || (!existingIsMime && candidateIsMime)) && typeof mimeType === "string") {
            existing.mimeType = mimeType;
        }
        return;
    }
    refs.set(fileId, {
        fileId,
        preferredName,
        mimeType: typeof mimeType === "string" ? mimeType : undefined,
        sources: [source]
    });
}

export function extractChatGPTAssetReferences(value: any): ChatGPTAssetReference[] {
    const refs = new Map<string, ChatGPTAssetReference>();
    const seenObjects = new WeakSet<object>();

    const walk = (node: any): void => {
        if (!node || typeof node !== "object") return;
        if (seenObjects.has(node)) return;
        seenObjects.add(node);

        if (Array.isArray(node)) {
            for (const child of node) walk(child);
            return;
        }

        const pointer = typeof node.asset_pointer === "string" ? node.asset_pointer : "";
        if (pointer.includes("://")) {
            const separator = pointer.indexOf("://");
            const scheme = pointer.slice(0, separator);
            const fileId = pointer.slice(separator + 3);
            if (scheme === "file-service" || scheme === "sediment") {
                addRef(
                    refs,
                    fileId,
                    node.name || node.file_name || (node.content_type === "image_asset_pointer" ? "image" : fileId),
                    "asset_pointer",
                    node.mime_type || node.content_type
                );
            }
        }

        if (Array.isArray(node.attachments)) {
            for (const attachment of node.attachments) {
                if (!attachment || typeof attachment !== "object") continue;
                addRef(
                    refs,
                    attachment.id || attachment.file_id,
                    attachment.name || attachment.file_name || attachment.title,
                    "attachment",
                    attachment.mime_type || attachment.content_type
                );
            }
        }

        if (Array.isArray(node.citations)) {
            for (const citation of node.citations) {
                if (!citation || typeof citation !== "object") continue;
                const meta = citation.metadata && typeof citation.metadata === "object"
                    ? citation.metadata
                    : {};
                addRef(
                    refs,
                    meta.file_id || citation.file_id,
                    meta.title || citation.title || "citation",
                    "citation",
                    meta.mime_type || citation.mime_type
                );
            }
        }

        if (
            typeof node.file_id === "string"
            && ["name", "file_name", "title", "mime_type", "content_type"].some(key => key in node)
        ) {
            addRef(
                refs,
                node.file_id,
                node.name || node.file_name || node.title,
                "file_id",
                node.mime_type || node.content_type
            );
        }

        for (const child of Object.values(node)) {
            if (child && typeof child === "object") walk(child);
        }
    };

    walk(value);
    return [...refs.values()].sort((a, b) => a.fileId.localeCompare(b.fileId));
}

export function extractChatGPTGptFileReferences(value: any): ChatGPTAssetReference[] {
    const refs = new Map<string, ChatGPTAssetReference>();
    const seenObjects = new WeakSet<object>();

    const walk = (node: any): void => {
        if (!node || typeof node !== "object") {
            if (typeof node === "string" && /^file-[A-Za-z0-9_-]+$/.test(node)) {
                addRef(refs, node, node, "gpt_file");
            }
            return;
        }
        if (seenObjects.has(node)) return;
        seenObjects.add(node);

        if (Array.isArray(node)) {
            for (const child of node) {
                if (typeof child === "string" && /^file-[A-Za-z0-9_-]+$/.test(child)) {
                    addRef(refs, child, child, "gpt_file");
                } else {
                    walk(child);
                }
            }
            return;
        }

        if (typeof node.file_id === "string") {
            addRef(
                refs,
                node.file_id,
                node.name || node.file_name || node.title,
                "gpt_file",
                node.mime_type || node.content_type
            );
        }
        for (const child of Object.values(node)) walk(child);
    };

    walk(value);
    return [...refs.values()].sort((a, b) => a.fileId.localeCompare(b.fileId));
}

export function findSignedAssetUrl(metadata: any): string | null {
    if (!metadata || typeof metadata !== "object") return null;
    const seenObjects = new WeakSet<object>();
    let found: string | null = null;

    const walk = (node: any): void => {
        if (found || !node || typeof node !== "object") return;
        if (seenObjects.has(node)) return;
        seenObjects.add(node);

        if (Array.isArray(node)) {
            for (const child of node) walk(child);
            return;
        }

        for (const key of SIGNED_URL_KEY_PRIORITY) {
            const value = node[key];
            if (typeof value === "string" && value.startsWith("https://")) {
                found = value;
                return;
            }
        }
        for (const child of Object.values(node)) walk(child);
    };

    walk(metadata);
    return found;
}

export function redactChatGPTAssetMetadata(value: any): any {
    const seen = new WeakMap<object, any>();

    const clone = (node: any): any => {
        if (!node || typeof node !== "object") return node;
        if (seen.has(node)) return "[CIRCULAR]";

        const target: any = Array.isArray(node) ? [] : {};
        seen.set(node, target);

        if (Array.isArray(node)) {
            for (const item of node) target.push(clone(item));
            return target;
        }

        for (const [key, child] of Object.entries(node)) {
            if (SIGNED_URL_KEYS.has(key) && typeof child === "string") {
                target[key] = "[REDACTED_SIGNED_URL]";
            } else {
                target[key] = clone(child);
            }
        }
        return target;
    };

    return clone(value);
}

function privateLiteralHost(hostname: string): boolean {
    const h = hostname.toLowerCase();
    if (h === "localhost" || h === "localhost.localdomain" || h.endsWith(".localhost")) return true;
    if (h.startsWith("[") && h.endsWith("]")) return true;

    // Browser extensions cannot synchronously verify DNS resolution here.
    // Reject obvious private/reserved literal IPv4 ranges; runtime download
    // policy must still use narrow host permissions and browser CORS boundaries.
    const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!ipv4) return false;
    const octets = ipv4.slice(1).map(Number);
    if (octets.some(value => value < 0 || value > 255)) return true;
    const [a, b] = octets;
    return a === 0
        || a === 10
        || a === 127
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168)
        || a >= 224;
}

export function validateEphemeralSignedAssetUrl(value: string): URL {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error("Asset resolver returned an invalid URL");
    }
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
        throw new Error("Asset resolver URL is not acceptable HTTPS");
    }
    if (url.port && url.port !== "443") {
        throw new Error("Asset resolver URL uses an unexpected port");
    }
    if (privateLiteralHost(url.hostname)) {
        throw new Error("Asset resolver URL points to a local/private/reserved host");
    }
    return url;
}

export async function resolveChatGPTAsset(
    client: ChatGPTClient,
    workspaceId: string,
    ref: ChatGPTAssetReference,
    context: { conversationId?: string; projectId?: string }
): Promise<ChatGPTAssetResolution> {
    const metadata = await client.resolveFile(ref.fileId, workspaceId, context);
    const signedUrl = findSignedAssetUrl(metadata);
    if (!signedUrl) throw new Error(`No signed download URL for ChatGPT asset ${ref.fileId}`);
    validateEphemeralSignedAssetUrl(signedUrl);

    return {
        fileId: ref.fileId,
        preferredName: ref.preferredName,
        signedUrl,
        redactedResolverMetadata: redactChatGPTAssetMetadata(metadata)
    };
}
