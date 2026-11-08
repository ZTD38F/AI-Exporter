import type { Account } from '../../l2/accountRegistry.js';
import type { ReadonlyDomain } from '../../l2/runtimeValidation.js';
import type { ResourceBindings } from './resourceBindings.js';
import type { PreparedResources } from '../../shared/resources/resourceResult.js';
import type { ExportArtifact } from '../artifacts.js';
import { buildExportFileName, sanitizeFileName, shortScope } from '../../shared/utils/pathUtils.js';
import { ZipWriter } from './writers/zipWriter.js';
import { docxImageInfo } from '../shared/docxImageType.js';
import { assertExportPath } from './exportPath.js';

export type ExportFormat = 'markdown' | 'html' | 'json' | 'pdf' | 'docx';
export type ExportDelivery = 'browserDownload' | 'folderWriter';
export type ExportPathPlan = Readonly<{
    fileName: string;
    resources: ResourceBindings;
    externalResourceIds: ReadonlySet<string>;
}>;
const extensions: Readonly<Record<ExportFormat, string>> = { markdown: 'md', html: 'html', json: 'json', pdf: 'pdf', docx: 'docx' };
const mimeTypes: Readonly<Record<ExportFormat, string>> = { markdown: 'text/markdown; charset=utf-8', html: 'text/html; charset=utf-8',
    json: 'application/json; charset=utf-8', pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
const resourceExtensions: Readonly<Record<string, string>> = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/svg+xml': 'svg', 'application/pdf': 'pdf', 'text/plain': 'txt',
    'text/markdown': 'md', 'application/json': 'json', 'audio/mpeg': 'mp3', 'video/mp4': 'mp4',
};

/** Reuse one path namespace across a batch without retaining every resource byte. */
export function createExportPathPlanner(format: ExportFormat, resourceScope?: string):
    (conversation: ReadonlyDomain, prepared: PreparedResources, fileIds: ReadonlySet<string>, fileBaseName?: string,
        expectedIds?: ReadonlySet<string>, folderAccount?: Account) => ExportPathPlan {
    const used = new Set<string>();
    function reserve(directory: string, name: string, names = used): string {
        // Percent is literal source text, never a second encoded path supplied to a writer.
        const clean = sanitizeFileName(name.replace(/%/g, '_'));
        const lastDot = clean.lastIndexOf('.');
        const dot = lastDot > 0 && clean.length - lastDot <= 6 ? lastDot : -1;
        const base = dot > 0 ? clean.slice(0, dot) : clean;
        const ext = dot > 0 ? clean.slice(dot) : '';
        for (let n = 1; ; n++) {
            const suffix = n === 1 ? '' : `_${n}`;
            const candidate = directory + sanitizeFileName([...base].slice(0, 70 - suffix.length).join('') + suffix + ext);
            assertExportPath(candidate);
            const key = candidate.toLowerCase();
            if (!names.has(key)) { names.add(key); return candidate; }
        }
    }
    return (conversation, prepared, fileIds, fileBaseName, expectedIds, folderAccount) => {
        const id = conversation.index.key.conversationId;
        const fileName = reserve('', fileBaseName ? `${fileBaseName}.${extensions[format]}`
            : buildExportFileName(conversation.index.title, id, extensions[format]));
        const resources: Record<string, string> = {};
        const externalResourceIds = new Set<string>();
        // Folder attachments have stable, account-owned paths across tasks and formats.
        const resourceNames = folderAccount ? new Set<string>() : used;
        const scope = folderAccount
            ? [folderAccount.providerId, folderAccount.id, id].map(value => sanitizeFileName(value.replace(/%/g, '_'))).join('/')
            : resourceScope;
        for (const asset of conversation.detail.assets) {
            const result = prepared.get(asset.id);
            // Linked documents reserve paths from metadata before attachment acquisition.
            // Acquisition must use these same paths even when response metadata differs.
            if (!result?.ok && !expectedIds?.has(asset.id)) continue;
            const acquired = result?.ok ? result.value : undefined;
            const mediaType = acquired?.mediaType ?? asset.mediaType;
            const extension = resourceExtensions[mediaType ?? ''] ?? (asset.document ? 'md' : asset.kind === 'image' ? 'jpg' : 'bin');
            const baseName = sanitizeFileName(asset.name || asset.id);
            const name = asset.name && /\.[^.]+$/.test(baseName) ? baseName : `${baseName}.${extension}`;
            const directory = asset.kind === 'image' ? 'assets/' : 'files/';
            resources[asset.id] = reserve(directory + (scope ? `${scope}/` : ''),
                (folderAccount ? '' : shortScope(id)) + name, resourceNames);
            const embeddedDocxImage = format === 'docx' && asset.kind === 'image'
                && acquired !== undefined && docxImageInfo(mediaType, acquired.bytes) !== undefined;
            if ((format !== 'pdf' && !embeddedDocxImage) || fileIds.has(asset.id)) externalResourceIds.add(asset.id);
        }
        return { fileName, resources, externalResourceIds };
    };
}

/** Browser downloads still plan their complete batch after resource preparation. */
export function planExportPaths(
    inputs: readonly { conversation: ReadonlyDomain; prepared: PreparedResources; fileIds: ReadonlySet<string> }[],
    format: ExportFormat,
): readonly ExportPathPlan[] {
    const planNext = createExportPathPlanner(format);
    return inputs.map(({ conversation, prepared, fileIds }) => planNext(conversation, prepared, fileIds));
}

/** Application fills prepared mediaType from acquisition metadata, then trusted
 * DomainAsset.mediaType. Packaging uses octet-stream when neither is available. */
export function buildExportFiles(format: ExportFormat, plan: ExportPathPlan,
    content: string | Uint8Array, prepared: PreparedResources): ExportArtifact[] {
    assertExportPath(plan.fileName);
    return [{ fileName: plan.fileName, mimeType: mimeTypes[format], content }, ...buildResourceFiles(plan, prepared)];
}

/** Build attachments separately without rendering or rewriting an already delivered body. */
export function buildResourceFiles(plan: ExportPathPlan, prepared: PreparedResources): ExportArtifact[] {
    const files: ExportArtifact[] = [];
    for (const id of plan.externalResourceIds) {
        const path = plan.resources[id];
        if (!path) throw new Error(`External resource has no planned path: ${id}`);
        assertExportPath(path);
        const result = prepared.get(id);
        if (!result?.ok) throw new Error(`Bound resource unavailable: ${id}`);
        files.push({ fileName: path, mimeType: result.value.mediaType ?? 'application/octet-stream', content: result.value.bytes });
    }
    return files;
}

export async function packageExportFiles(groups: readonly (readonly ExportArtifact[])[],
    delivery: ExportDelivery, archiveName?: string): Promise<ExportArtifact[]> {
    const nonempty = groups.filter(group => group.length > 0);
    const files = nonempty.flatMap(group => [...group]);
    const paths = new Set<string>();
    for (const file of files) {
        assertExportPath(file.fileName);
        const key = file.fileName.toLowerCase();
        if (paths.has(key)) throw new Error(`Duplicate export path: ${file.fileName}`);
        paths.add(key);
    }
    if (!files.length || !(delivery === 'browserDownload' && (files.length > 1 || archiveName))) return files;
    const writer = new ZipWriter();
    for (const file of files) {
        if (writer.writeFile(file.fileName, file.content) !== file.fileName) throw new Error('ZIP writer changed planned path');
    }
    const fileName = archiveName ? sanitizeFileName(archiveName) : nonempty.length === 1
        ? sanitizeFileName(nonempty[0][0].fileName.replace(/\.[^.]+$/, '') + '.zip')
        : `conversations_${Date.now()}.zip`;
    return [{ fileName, mimeType: 'application/zip', content: await writer.generateBlob() }];
}
