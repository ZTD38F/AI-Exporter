import type { Asset } from './assets.js';
import type { CanonicalConversationBundle } from './conversation.js';
import type { TypstConversationRenderPayload } from '../typst/payload.js';

export interface RenderDiagnostic {
    severity: 'info' | 'warning' | 'error';
    code: string;
    message: string;
    path?: string;
}

export interface ResolvedAsset {
    asset: Asset;
    blob?: Blob;
    bytes?: Uint8Array;
    renderUrl?: string;
}

export interface AssetResolver {
    resolve(assetId: string): Promise<ResolvedAsset | null>;
}

export interface RenderContext {
    bundle: CanonicalConversationBundle;
    assets: AssetResolver;
    locale: 'zh' | 'en';
    signal: AbortSignal;
    reportProgress(stage: string, current: number, total: number): void;
}

export interface CompanionResourcePlan {
    resourceIds: string[];
    omitted: Array<{ resourceId: string; reason: string }>;
}

export interface ArtifactWriteReport {
    fileName: string;
    target: 'zip' | 'folder' | string;
    bytesWritten: number;
    writtenAt: string;
}

export interface ExportArtifact {
    fileName: string;
    mimeType: string;
    content: string | Blob | Uint8Array;
    companionResourceIds: string[];
    companionPlan?: CompanionResourcePlan;
    writeReport?: ArtifactWriteReport;
    diagnostics?: RenderDiagnostic[];
}

export interface ThoughtRenderOptions {
    initiallyCollapsed?: boolean;
}

export interface ConversationRenderer {
    readonly format: 'html' | 'markdown' | 'pdf' | string;
    render(context: RenderContext): Promise<ExportArtifact>;
}

export interface TypstRenderPayload {
    rendererSchemaVersion: 1;
    sourceSchemaVersion: 1;
    bundle: CanonicalConversationBundle;
    document: TypstConversationRenderPayload;
    assetPaths: ReadonlyMap<string, string>;
}
