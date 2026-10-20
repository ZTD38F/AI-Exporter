import { isAbortError } from '../errors.js';
import type { RenderDiagnostic } from '../../canonical/rendering.js';
import {
    StageError,
    type PipelineStageName,
    type StageContext,
    type StageFn,
} from './types.js';

export async function runStage<I, O>(
    stage: PipelineStageName,
    fn: StageFn<I, O>,
    input: I,
    ctx: StageContext,
): Promise<{ output: O; diagnostics: RenderDiagnostic[] }> {
    if (ctx.signal.aborted) {
        throw new DOMException(`Pipeline aborted before stage '${stage}'`, 'AbortError');
    }
    try {
        return await fn(input, ctx);
    } catch (e) {
        if (isAbortError(e) || e instanceof StageError) {
            throw e;
        }
        throw new StageError(stage, 'STAGE_THREW', `Stage '${stage}' threw: ${(e as Error)?.message ?? String(e)}`, {
            cause: e,
        });
    }
}
