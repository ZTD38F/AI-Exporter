import type { Diagnostic } from '../../../shared/diagnostics/diagnostic.js';
import type { TypstConversationRenderPayload } from '../typst/transport.js';

/** Prepared output bytes, never a semantic Asset or source conversation. */
export interface PdfResource { blob?: Blob; bytes?: Uint8Array }
export interface PdfCompileContext {
    assets: { resolve(resourceId: string): Promise<PdfResource | null> };
    signal: AbortSignal;
    reportProgress(stage: string, current: number, total: number): void;
}
export interface TypstRenderPayload {
    rendererSchemaVersion: 1;
    document: TypstConversationRenderPayload;
    assetPaths: ReadonlyMap<string, string>;
}
export interface PdfCompileResult {
    pdfBytes: Uint8Array;
    diagnostics: Diagnostic[];
}
export interface IPdfCompiler {
    readonly name: string;
    /** Optional runtime-font capability; compilers without it use bundled fonts. */
    setRuntimeFonts?(fonts: Uint8Array[]): void;
    compile(payload: TypstRenderPayload, context: PdfCompileContext): Promise<PdfCompileResult>;
}
