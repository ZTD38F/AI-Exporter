import type { RenderDiagnostic } from '../../canonical/rendering.js';
import type { TypstAdapterDiagnostic } from '../../typst/payload.js';
import { toTypstPayload } from '../../typst/payload.js';
import { convertMathWithMitex, initMitexWasm } from '../../typst/mathConverter.js';
import {
    type PayloadStageInput,
    type PayloadStageOutput,
    type StageContext,
    type StageFn,
} from './types.js';

function mapDiagnostic(d: TypstAdapterDiagnostic): RenderDiagnostic {
    return { severity: d.severity, code: d.code, message: d.message, path: d.path };
}

export const payloadStage: StageFn<PayloadStageInput, PayloadStageOutput> = async (
    input: PayloadStageInput,
    ctx: StageContext,
) => {
    if (ctx.signal.aborted) {
        throw new DOMException(`Pipeline aborted before stage 'payload'`, 'AbortError');
    }

    const initDiagnostics: TypstAdapterDiagnostic[] = [];
    let mitexAvailable = true;

    try {
        await initMitexWasm();
    } catch (err: any) {
        mitexAvailable = false;
        initDiagnostics.push({
            severity: 'warning',
            code: 'TYPST_MATH_INIT_FAILED',
            message: `MiTeX WASM initialization failed: ${err?.message ?? String(err)}. Math formulas preserved as raw LaTeX fallback.`,
        });
    }

    // Capture math conversion diagnostics in the closure since the convertMath callback only returns string | undefined.
    const mathDiagnostics: TypstAdapterDiagnostic[] = [];
    const result = toTypstPayload(input.bundle, {
        assetPath: (asset) => input.pathMap.get(asset.id),
        locale: input.locale,
        convertMath: (source, display) => {
            if (!mitexAvailable) {
                return undefined;
            }
            const converted = convertMathWithMitex(source, 'latex', display);
            if (converted.diagnostic) mathDiagnostics.push(converted.diagnostic);
            return converted.typst;
        },
    });
    const diagnostics = [...result.diagnostics, ...initDiagnostics, ...mathDiagnostics].map(mapDiagnostic);
    return { output: { payload: result.payload }, diagnostics };
};
