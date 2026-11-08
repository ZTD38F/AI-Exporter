import { OperationError, type OperationErrorCode } from '../../../shared/errors/operationError.js';
import { readSourceExecution, type SourceExecutionResult } from '../sourceExecution.js';
import { hasPlatformAccess } from '../platformAccess.js';
import { grokUuid } from '../../parsers/grok/source.js';
export function hasGrokAccess(): Promise<boolean> { return hasPlatformAccess('grok'); }
export function validGrokRead(path: string, body?: { responseIds: string[] }): boolean {
    if (body) return /^\/rest\/app-chat\/conversations\/[\da-f-]{36}\/load-responses$/i.test(path)
        && body.responseIds.length > 0 && body.responseIds.length <= 100 && body.responseIds.every(grokUuid);
    return path === '/rest/auth/get-user'
        || /^\/rest\/app-chat\/conversations\?pageSize=60(?:&pageToken=[\da-f-]{36})?$/i.test(path)
        || /^\/rest\/app-chat\/conversations_v2\/[\da-f-]{36}\?includeWorkspaces=true&includeTaskResult=true$/i.test(path)
        || /^\/rest\/app-chat\/conversations\/[\da-f-]{36}\/response-node\?includeThreads=true$/i.test(path);
}
/** Only read APIs, including Grok's POST batch reader, execute in the authenticated tab. */
export async function readGrokSource(path: string, expectedUser?: string, body?: { responseIds: string[] }): Promise<unknown> {
    if (!validGrokRead(path, body) || expectedUser !== undefined && !grokUuid(expectedUser)) throw new TypeError('Invalid Grok API read');
    if (!await hasGrokAccess()) throw new OperationError('PLATFORM_PERMISSION_REQUIRED', 'Grok host permission unavailable');
    const tabs = (await chrome.tabs.query({ url: ['https://grok.com/*'] }))
        .sort((a, b) => Number(!!b.active) - Number(!!a.active))
        .flatMap(tab => tab.id === undefined ? [] : [tab.id]);
    let failure: unknown = new OperationError('SOURCE_PAGE_UNAVAILABLE', 'Open Grok and log in before continuing');
    for (const tabId of tabs) {
        try {
            const results = await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED',
                func: async (resource: string, owner: string | null, payload: { responseIds: string[] } | null): Promise<SourceExecutionResult> => {
                    // This class lives inside the injected realm; serialize before returning to the extension.
                    class RequestFailure extends Error {
                        constructor(readonly code: OperationErrorCode, message: string, readonly httpStatus?: number) { super(message); }
                    }
                    try {
                        const get = async (path: string, body?: { responseIds: string[] }): Promise<unknown> => {
                            const r = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json' },
                                ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
                            if (!r.ok) throw new RequestFailure('SOURCE_HTTP_ERROR', 'Grok API HTTP ' + r.status, r.status);
                            return r.json();
                        };
                        const verify = async () => {
                            const user = await get('/rest/auth/get-user');
                            if (!user || typeof user !== 'object' || !('userId' in user) || typeof user.userId !== 'string')
                                throw new RequestFailure('SOURCE_RESPONSE_INVALID', 'Invalid Grok current user');
                            if (user.userId !== owner) throw new RequestFailure('ACCOUNT_CHANGED', 'Grok account changed');
                        };
                        if (owner) await verify();
                        const result = await get(resource, payload ?? undefined);
                        if (owner) await verify();
                        return { ok: true, value: result };
                    } catch (error) {
                        return { ok: false, issue: { code: error instanceof RequestFailure ? error.code : 'UNKNOWN_ERROR',
                            message: error instanceof Error ? error.message : 'Unknown error',
                            ...(error instanceof RequestFailure && error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}) } };
                    }
                }, args: [path, expectedUser ?? null, body ?? null] });
            if (results.length !== 1 || results[0]?.result === undefined) throw new OperationError('SOURCE_RESPONSE_INVALID', 'Grok source returned no data');
            return readSourceExecution(results[0].result);
        } catch (error) { if (error instanceof OperationError && error.httpStatus === 429) throw error; failure = error; }
    }
    throw failure;
}
