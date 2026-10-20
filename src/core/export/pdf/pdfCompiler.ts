import type {
    RenderContext,
    RenderDiagnostic,
    TypstRenderPayload,
} from '../canonical/rendering.js';

export interface PdfCompileResult {
    pdfBytes: Uint8Array;
    diagnostics: RenderDiagnostic[];
}

export interface IPdfCompiler {
    readonly name: string;
    compile(payload: TypstRenderPayload, context: RenderContext): Promise<PdfCompileResult>;
}
