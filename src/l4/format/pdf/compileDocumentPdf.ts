import { OperationError } from '../../../shared/errors/operationError.js';
import type { DocumentAst, DisplayBlock, DisplayInline } from '../../../l3b/ast/ast.js';
import type { ResourceBindings } from '../../packaging/resourceBindings.js';
import type { Diagnostic } from '../../../shared/diagnostics/diagnostic.js';
import { missingResource } from '../../../shared/resources/resourceResult.js';
import type { PreparedResources } from '../../../shared/resources/resourceResult.js';
import type { RendererOptions } from '../shared/renderOptions.js';
import { renderDocumentTypstCore } from '../typst/renderTypstCore.js';
import { PdfResourceError } from './errors.js';
import { isResourcePath } from '../shared/resourcePath.js';
import { initMitexWasm, convertMathWithMitex } from '../typst/mathConverter.js';
import { checkImageContent, MAX_ASSET_BYTES } from '../resources/imageContent.js';
import type { IPdfCompiler, PdfCompileContext, PdfCompileResult } from './pdfCompiler.js';

/** Only actual AST Image uses enter the Typst virtual filesystem. */
function collectPdfImageIds(document: DocumentAst): ReadonlySet<string> {
    const ids = new Set<string>();
    const inline = (node: DisplayInline): void => {
        if (node.type === 'image') ids.add(node.resourceId);
        if ('children' in node) node.children.forEach(inline);
    };
    const block = (node: DisplayBlock): void => {
        switch (node.type) {
            case 'image': ids.add(node.resourceId); node.caption?.forEach(inline); break;
            case 'paragraph': case 'heading': node.children.forEach(inline); break;
            case 'quote': case 'disclosure': node.blocks.forEach(block); break;
            case 'list': node.items.forEach(item => item.blocks.forEach(block)); break;
            case 'table':
                node.caption?.forEach(inline);
                [...node.headerRows, ...node.rows].forEach(row => row.forEach(cell => cell.children.forEach(inline)));
                break;
            case 'file': node.description?.forEach(inline); break;
            default: break;
        }
    };
    document.messages.forEach(message => message.blocks.forEach(block));
    return ids;
}

/** Format-only calculation. The caller supplies image bytes, paths, initialized fonts
 * and compiler lifetime; batching, acquisition, delivery and records stay upstream. */
export async function compileDocumentPdf(
    document: DocumentAst,
    bindings: ResourceBindings,
    prepared: PreparedResources,
    compiler: IPdfCompiler,
    context: Omit<PdfCompileContext, 'assets'>,
    options: RendererOptions = {},
): Promise<PdfCompileResult> {
    context.signal.throwIfAborted();
    const resourceFailures = { ...options.resourceFailures };
    options = { ...options, resourceFailures };
    const diagnostics: Diagnostic[] = [];
    const report = (diagnostic: Diagnostic): void => {
        diagnostics.push(diagnostic);
        if (diagnostic.code === 'FORMAT_CONTENT_OMITTED' && diagnostic.path?.startsWith('asset:')) {
            const id = diagnostic.path.slice(6);
            resourceFailures[id] = missingResource(id, diagnostic.message, 'RESOURCE_PROCESSING_FAILED');
        }
    };
    const assetPaths = new Map<string, string>();
    const images = new Map<string, Uint8Array>();
    // One resource can be both a File and an Image in the AST. Only the Image
    // use enters Typst; Packaging independently delivers original File bytes.
    for (const id of collectPdfImageIds(document)) {
        context.signal.throwIfAborted();
        const result = prepared.get(id);
        if (!result?.ok) continue; // Acquisition failure belongs to Application.
        const path = bindings[id];
        if (!isResourcePath(path)) throw new TypeError(`Prepared image has no canonical Packaging binding: ${id}`);
        const { bytes, name, mediaType } = result.value;
        const diag = (_id: string, severity: Diagnostic['severity'], code: string, message: string): void =>
            report({ severity, code, message, path: `asset:${id}` });
        if (!bytes.length || bytes.length > MAX_ASSET_BYTES) {
            diag(id, 'warning', bytes.length ? 'ASSET_TOO_LARGE' : 'ASSET_ZERO_BYTES', 'Prepared image is empty or exceeds the PDF byte limit');
            diag(id, 'warning', 'FORMAT_CONTENT_OMITTED', 'PDF could not embed the successfully acquired image');
        } else if (checkImageContent({ id, name, mimeType: mediaType }, bytes, diag).ok) {
            assetPaths.set(id, path);
            images.set(id, bytes);
        } else {
            diag(id, 'warning', 'FORMAT_CONTENT_OMITTED', 'PDF could not embed the successfully acquired image');
        }
    }
    let convertMath: ((source: string, display: boolean) => string | undefined) | undefined;
    {
        try {
            await initMitexWasm();
            convertMath = (source, display) => {
                const result = convertMathWithMitex(source, 'latex', display);
                if (result.diagnostic) report(result.diagnostic);
                return result.typst;
            };
        } catch (error) {
            report({ severity: 'warning', code: 'TYPST_MATH_INIT_FAILED',
                message: `MiTeX unavailable; original LaTeX preserved: ${error instanceof Error ? error.message : String(error)}` });
        }
    }
    // A successful acquisition can still be rejected by Typst's image decoder.
    // Retry only that technical failure, as a visible placeholder, never re-fetching
    // or re-planning paths. Generic compiler failures remain fatal.
    let result: PdfCompileResult;
    for (;;) {
        context.signal.throwIfAborted();
        const payload = renderDocumentTypstCore(document, Object.fromEntries(assetPaths), options, { convertMath, onDiagnostic: report });
        try {
            result = await compiler.compile({ rendererSchemaVersion: 1, document: payload, assetPaths: new Map(assetPaths) }, {
                ...context,
                assets: { async resolve(id) {
                    context.signal.throwIfAborted();
                    const bytes = images.get(id);
                    return bytes ? { bytes } : null;
                } },
            });
            break;
        } catch (error) {
            context.signal.throwIfAborted();
            if (!(error instanceof PdfResourceError)) throw error;
            const unusable = error.failures.filter(f => images.has(f.resourceId));
            if (!unusable.length) throw error;
            for (const failure of unusable) {
                images.delete(failure.resourceId);
                assetPaths.delete(failure.resourceId);
                report({ severity: 'warning', code: 'FORMAT_CONTENT_OMITTED',
                    message: `PDF could not decode the prepared image: ${failure.reason}`, path: `asset:${failure.resourceId}` });
            }
        }
    }
    context.signal.throwIfAborted();
    const bytes = result.pdfBytes;
    if (!(bytes instanceof Uint8Array) || bytes.length < 64 || String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') {
        throw new OperationError('PDF_INVALID_OUTPUT', 'Compiler returned empty, truncated or invalid PDF bytes');
    }
    return { pdfBytes: bytes, diagnostics: [...diagnostics, ...result.diagnostics] };
}
