import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
    sealDeletionManifest,
    sha256Hex,
    stableJson,
    verifyDeletionManifest,
    verifyDeletionManifestDraft,
    type DeletionManifest,
    type DeletionManifestDraft
} from "./controlPlane.js";

export interface PersistedManifestPair {
    draftPath: string;
    draftFileSha256: string;
    sealedPath: string;
    sealedFileSha256: string;
    manifest: DeletionManifest;
}

async function durableImmutableWrite(path: string, content: string): Promise<string> {
    await mkdir(join(path, ".."), { recursive: true }).catch(() => undefined);
    try {
        const handle = await open(path, "wx", 0o600);
        try {
            await handle.writeFile(content, { encoding: "utf8" });
            await handle.sync();
        } finally {
            await handle.close();
        }
    } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
        const existing = await readFile(path, "utf8");
        if (existing !== content) {
            throw new Error("Immutable manifest path already exists with different content: " + path);
        }
    }

    const readBack = await readFile(path, "utf8");
    if (readBack !== content) throw new Error("Manifest read-back verification failed: " + path);
    return sha256Hex(readBack);
}

function safeArtifactName(prefix: string, digest: string, suffix: string): string {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Manifest digest is invalid");
    return prefix + "-" + digest + suffix;
}

export async function persistAndSealDeletionManifest(
    directory: string,
    draft: DeletionManifestDraft
): Promise<PersistedManifestPair> {
    if (!verifyDeletionManifestDraft(draft)) throw new Error("Refusing to persist invalid deletion manifest draft");

    const draftContent = stableJson(draft);
    const draftPath = join(
        directory,
        safeArtifactName("manifest", draft.draftSha256, ".draft.json")
    );
    const draftFileSha256 = await durableImmutableWrite(draftPath, draftContent);

    const verifiedDraft = JSON.parse(await readFile(draftPath, "utf8")) as DeletionManifestDraft;
    if (!verifyDeletionManifestDraft(verifiedDraft) || verifiedDraft.draftSha256 !== draft.draftSha256) {
        throw new Error("Deletion manifest draft backup failed semantic verification");
    }

    const manifest = sealDeletionManifest(verifiedDraft, {
        draftSha256: draft.draftSha256,
        verified: true
    });
    if (!verifyDeletionManifest(manifest)) throw new Error("Sealed deletion manifest failed verification");

    const sealedContent = stableJson(manifest);
    const sealedPath = join(
        directory,
        safeArtifactName("manifest", manifest.manifestSha256, ".sealed.json")
    );
    const sealedFileSha256 = await durableImmutableWrite(sealedPath, sealedContent);

    const verifiedManifest = JSON.parse(await readFile(sealedPath, "utf8")) as DeletionManifest;
    if (!verifyDeletionManifest(verifiedManifest) || verifiedManifest.manifestSha256 !== manifest.manifestSha256) {
        throw new Error("Sealed deletion manifest read-back verification failed");
    }

    return {
        draftPath,
        draftFileSha256,
        sealedPath,
        sealedFileSha256,
        manifest: verifiedManifest
    };
}
