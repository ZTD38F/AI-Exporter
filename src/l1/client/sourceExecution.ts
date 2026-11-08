import { OperationError, readOperationIssue, type OperationIssue } from '../../shared/errors/operationError.js';
export type SourceExecutionResult = { ok: true; value: unknown } | { ok: false; issue: OperationIssue };
export function readSourceExecution(result: unknown): unknown {
    if (result && typeof result === 'object' && 'ok' in result) {
        if (result.ok === true && 'value' in result) return result.value;
        const issue = result.ok === false && 'issue' in result ? readOperationIssue(result.issue) : null;
        if (issue) throw new OperationError(issue.code, issue.message, issue.httpStatus);
    }
    throw new OperationError('SOURCE_RESPONSE_INVALID', 'Source execution returned an invalid result');
}
