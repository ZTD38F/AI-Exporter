/**
 * OpenAI / ChatGPT official data-export ZIP importer.
 *
 * This parser intentionally treats the original ZIP as source evidence.
 * It builds a working conversation index without silently erasing conflicts.
 */
import { ZipBombGuard } from "../../engine/takeout/zipBombGuard.js";

declare global {
    var JSZip: any;
}

export interface ChatGPTOfficialExportConflict {
    conversationId: string;
    selectedSource: string;
    variantSources: string[];
    reason: "DUPLICATE_ID_DIFFERENT_CONTENT";
    updateMarkers: Record<string, string | null>;
}

export interface ChatGPTOfficialImportError {
    source: string;
    code: string;
    message: string;
    index?: number;
}

export interface ChatGPTOfficialAssetEntry {
    path: string;
    name: string;
    uncompressedSize?: number;
}

export interface ChatGPTOfficialImportResult {
    schemaVersion: 1;
    providerId: "chatgpt";
    sourceType: "openai-data-export";
    conversationJsonFiles: string[];
    conversations: any[];
    conversationSources: Record<string, string[]>;
    conflicts: ChatGPTOfficialExportConflict[];
    errors: ChatGPTOfficialImportError[];
    assetEntries: ChatGPTOfficialAssetEntry[];
    importIntegrityComplete: boolean;
}

const MAX_CONVERSATION_JSON_UNCOMPRESSED = 300 * 1024 * 1024;

function safeEntryPath(path: string): string {
    const normalized = String(path || "").replace(/\\/g, "/");
    if (
        !normalized
        || normalized.startsWith("/")
        || /^[A-Za-z]:\//.test(normalized)
        || normalized.split("/").some(part => part === ".." || part === ".")
    ) {
        throw new Error(`Unsafe ZIP entry path: ${path}`);
    }
    return normalized;
}

function isConversationJsonPath(path: string): boolean {
    const name = path.replace(/^.*\//, "");
    return /^conversations(?:-\d+)?\.json$/i.test(name);
}

function conversationId(value: any): string | null {
    if (!value || typeof value !== "object") return null;
    for (const key of ["id", "conversation_id", "conversationId"]) {
        const id = value[key];
        if (typeof id === "string" && id.trim()) return id.trim();
    }
    return null;
}

function remoteUpdateMarker(value: any): string | null {
    if (!value || typeof value !== "object") return null;
    for (const key of ["update_time", "updated_at", "create_time", "created_at"]) {
        const marker = value[key];
        if (marker !== null && marker !== undefined && String(marker).trim()) {
            return String(marker);
        }
    }
    return null;
}

function timestampValue(marker: string | null): number | null {
    if (!marker) return null;
    const numeric = Number(marker);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(marker);
    return Number.isFinite(parsed) ? parsed : null;
}

function choosePreferredVariant(
    current: { source: string; value: any },
    incoming: { source: string; value: any }
): { source: string; value: any } {
    const currentTs = timestampValue(remoteUpdateMarker(current.value));
    const incomingTs = timestampValue(remoteUpdateMarker(incoming.value));

    if (currentTs !== null && incomingTs !== null && incomingTs !== currentTs) {
        return incomingTs > currentTs ? incoming : current;
    }
    if (incomingTs !== null && currentTs === null) return incoming;
    if (currentTs !== null && incomingTs === null) return current;

    // Stable deterministic fallback independent of ZIP iteration order.
    return incoming.source.localeCompare(current.source) < 0 ? incoming : current;
}

function extractConversationArray(parsed: any): any[] | null {
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.conversations)) {
        return parsed.conversations;
    }
    if (parsed && typeof parsed === "object" && conversationId(parsed)) {
        return [parsed];
    }
    return null;
}

function jsonFingerprint(value: any): string {
    // This is an equality fingerprint within the current import, not a
    // cryptographic integrity hash. SHA-256 is written later by the archive writer.
    return JSON.stringify(value);
}

export async function parseChatGPTOfficialExportZip(
    file: any,
    onProgress?: (progress: { phase: string; current: number; total: number; source?: string }) => void
): Promise<ChatGPTOfficialImportResult> {
    if (typeof JSZip === "undefined") {
        throw new Error("JSZip is not available");
    }

    ZipBombGuard.validateZipFile(file);
    const zip = file && typeof file.file === "function" && file.files
        ? file
        : await JSZip.loadAsync(file);
    ZipBombGuard.validateZipEntries(zip);

    const safeEntries: Array<{ path: string; entry: any }> = [];
    for (const [rawPath, entry] of Object.entries<any>(zip.files || {})) {
        const path = safeEntryPath(rawPath);
        if (entry?.dir) continue;
        safeEntries.push({ path, entry });
    }

    const conversationEntries = safeEntries
        .filter(({ path }) => isConversationJsonPath(path))
        .sort((a, b) => a.path.localeCompare(b.path));

    if (!conversationEntries.length) {
        throw new Error("No conversations.json or numbered conversations-*.json files were found in the OpenAI export ZIP");
    }

    const assetEntries: ChatGPTOfficialAssetEntry[] = safeEntries
        .filter(({ path }) => !isConversationJsonPath(path))
        .filter(({ path }) => !/^(?:^|.*\/)(?:chat|message_feedback|model_comparisons|user|account|shared_conversations)\.json$/i.test(path))
        .map(({ path, entry }) => ({
            path,
            name: path.replace(/^.*\//, ""),
            uncompressedSize:
                typeof entry?._data?.uncompressedSize === "number"
                    ? entry._data.uncompressedSize
                    : undefined
        }))
        .sort((a, b) => a.path.localeCompare(b.path));

    const errors: ChatGPTOfficialImportError[] = [];
    const byId = new Map<string, { source: string; value: any; fingerprint: string }>();
    const sources = new Map<string, string[]>();
    const conflictSources = new Map<string, Set<string>>();
    const updateMarkers = new Map<string, Map<string, string | null>>();

    for (let fileIndex = 0; fileIndex < conversationEntries.length; fileIndex++) {
        const { path, entry } = conversationEntries[fileIndex];
        onProgress?.({
            phase: "conversations",
            current: fileIndex + 1,
            total: conversationEntries.length,
            source: path
        });

        const uncompressedSize = entry?._data?.uncompressedSize;
        if (
            typeof uncompressedSize === "number"
            && uncompressedSize > MAX_CONVERSATION_JSON_UNCOMPRESSED
        ) {
            errors.push({
                source: path,
                code: "CONVERSATION_JSON_TOO_LARGE",
                message: `Conversation JSON exceeds browser safety limit (${uncompressedSize} bytes)`
            });
            continue;
        }

        let parsed: any;
        try {
            const text = await entry.async("text");
            if (new TextEncoder().encode(text).byteLength > MAX_CONVERSATION_JSON_UNCOMPRESSED) {
                errors.push({
                    source: path,
                    code: "CONVERSATION_JSON_TOO_LARGE",
                    message: "Conversation JSON exceeds browser safety limit after decompression"
                });
                continue;
            }
            parsed = JSON.parse(text);
        } catch (error: any) {
            errors.push({
                source: path,
                code: "INVALID_CONVERSATION_JSON",
                message: error?.message || "Conversation JSON could not be parsed"
            });
            continue;
        }

        const records = extractConversationArray(parsed);
        if (!records) {
            errors.push({
                source: path,
                code: "CONVERSATION_SCHEMA_DRIFT",
                message: "Conversation JSON did not contain an array/object shape recognized by this importer"
            });
            continue;
        }

        for (let index = 0; index < records.length; index++) {
            const value = records[index];
            const id = conversationId(value);
            if (!id) {
                errors.push({
                    source: path,
                    code: "CONVERSATION_ID_MISSING",
                    message: "Conversation record is missing a stable id",
                    index
                });
                continue;
            }

            const sourceLabel = `${path}#${index}`;
            const sourceList = sources.get(id) || [];
            sourceList.push(sourceLabel);
            sources.set(id, sourceList);

            const markerMap = updateMarkers.get(id) || new Map<string, string | null>();
            markerMap.set(sourceLabel, remoteUpdateMarker(value));
            updateMarkers.set(id, markerMap);

            let fingerprint: string;
            try {
                fingerprint = jsonFingerprint(value);
            } catch {
                errors.push({
                    source: path,
                    code: "CONVERSATION_SERIALIZATION_FAILED",
                    message: "Conversation record contains a non-serializable value",
                    index
                });
                continue;
            }

            const existing = byId.get(id);
            if (!existing) {
                byId.set(id, { source: sourceLabel, value, fingerprint });
                continue;
            }

            if (existing.fingerprint === fingerprint) {
                continue;
            }

            const set = conflictSources.get(id) || new Set<string>([existing.source]);
            set.add(sourceLabel);
            conflictSources.set(id, set);

            const selected = choosePreferredVariant(
                { source: existing.source, value: existing.value },
                { source: sourceLabel, value }
            );
            if (selected.source === sourceLabel) {
                byId.set(id, { source: sourceLabel, value, fingerprint });
            }
        }
    }

    const conflicts: ChatGPTOfficialExportConflict[] = [...conflictSources.entries()]
        .map(([id, variantSet]) => {
            const selected = byId.get(id)!;
            const markerMap = updateMarkers.get(id) || new Map();
            return {
                conversationId: id,
                selectedSource: selected.source,
                variantSources: [...variantSet].sort(),
                reason: "DUPLICATE_ID_DIFFERENT_CONTENT" as const,
                updateMarkers: Object.fromEntries([...markerMap.entries()].sort(([a], [b]) => a.localeCompare(b)))
            };
        })
        .sort((a, b) => a.conversationId.localeCompare(b.conversationId));

    const conversations = [...byId.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, record]) => record.value);

    const conversationSources = Object.fromEntries(
        [...sources.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([id, values]) => [id, [...values].sort()])
    );

    return {
        schemaVersion: 1,
        providerId: "chatgpt",
        sourceType: "openai-data-export",
        conversationJsonFiles: conversationEntries.map(entry => entry.path),
        conversations,
        conversationSources,
        conflicts,
        errors,
        assetEntries,
        importIntegrityComplete: errors.length === 0 && conflicts.length === 0
    };
}
