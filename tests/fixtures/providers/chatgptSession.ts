import { describeFixtures, synthetic } from './provenance.js';
/** Native ChatGPT /api/auth/session JSON mock data. */
const indexSession = () => ({ accessToken: 'test-token', user: { id: 'u-index' }, account: { id: 'w-index' } });
const listSession = () => ({ accessToken: 'tok', user: { id: 'u-list' }, account: { id: 'workspace-list' } });
const fixtureMap = {
    'C_EXPORT_CANCEL_429_SOURCE_SESSION': () => ({ accessToken: 'tok', user: { id: 'export-user' }, account: { id: 'export-space' } }),
    'C_EXPORT_CANCEL_429_ASSET_SESSION': () => ({ accessToken: 'tok', user: { id: 'export-user' }, account: { id: 'export-space' } }),
    'C_TOKEN_REUSE_INITIAL': () => ({ accessToken: 'old-token' }),
    'C_TOKEN_REUSE_REFRESHED': () => ({ accessToken: 'refreshed-token' }),
    'C_ACCOUNT_CONTEXT_WORKSPACE_01': () => ({
        user: { id: 'subject' }, account: { id: 'workspace-1' }, accessToken: 'private-token',
    }),
    'C_ACCOUNT_CONTEXT_WORKSPACE_02': () => ({
        user: { id: 'subject' }, account: { id: 'workspace-2' }, accessToken: 'private-token',
    }),
    'C_ACCOUNT_CONTEXT_LOGOUT_01': () => ({}),
    'C_PROVIDER_CHATGPT_TREE_READINESS_01': () => ({}),
    'C_PROVIDER_CHATGPT_TREE_INVALID_TOKEN_01': () => ({
        accessToken: { bearer: 'not-a-string' },
        user: { id: 'invalid-token-user' }, account: { id: 'invalid-token-workspace' },
    }),
    'C_PROVIDER_CHATGPT_TREE_INVALID_DETAIL_SESSION_01': () => ({ accessToken: 'tok' }),
    'C_PROVIDER_CHATGPT_TREE_FOREIGN_DETAIL_SESSION_01': () => ({ accessToken: 'tok' }),
    'C_PROVIDER_CHATGPT_TREE_RETRY_429_SESSION_01': () => ({
        accessToken: 'tok', user: { id: 'retry-user' }, account: { id: 'retry-space' },
    }),
    'C_PROVIDER_CHATGPT_TREE_ABORT_429_SESSION_01': () => ({
        accessToken: 'tok', user: { id: 'abort-user' }, account: { id: 'abort-space' },
    }),
    'C_PROVIDER_CHATGPT_TREE_BOUNDED_429_SESSION_01': () => ({
        accessToken: 'tok', user: { id: 'bounded-user' }, account: { id: 'space' },
    }),
    'C_PROVIDER_CHATGPT_TREE_BOUNDED_429_SESSION_02': () => ({
        accessToken: 'tok', user: { id: 'another-user' }, account: { id: 'space' },
    }),
    'C_DISCOVERY_SESSION_01': () => ({
        accessToken: 'test-token', user: { id: 'user', name: 'Test user' }, account: { id: 'workspace' },
    }),
    'C_DISCOVERY_SESSION_02': () => ({}),
    'C_DISCOVERY_SESSION_03': () => ({
        accessToken: 'test-token', user: { id: 'user', name: 'Test user' },
    }),
    'C_DISCOVERY_SESSION_04': () => ({
        accessToken: '', user: { id: 'user', name: 'Test user' }, account: { id: 'workspace' },
    }),
    'C_DISCOVERY_SESSION_05': () => ({}),
    'C_DISCOVERY_SESSION_06': () => ({
        accessToken: '   ', user: { id: 'user', name: 'Test user' }, account: { id: 'workspace' },
    }),
    'C_L1_CLIENT_V2_MOCKED_03': () => ({
        accessToken: 'token', user: { id: 'user-1' }, account: { id: 'workspace-1' },
    }),
    'C_L1_CLIENT_V2_MOCKED_05': () => ({
        accessToken: 'token', user: { id: 'user-1' }, account: { id: 'workspace-1' },
    }),
    'C_L1_CONTRACT_20': () => ({
        accessToken: 'token', user: { id: 'other-user' }, account: { id: 'workspace' },
    }),
    'C_LIST_SOURCE_BOUNDARY_03': () => ({ accessToken: 'test-token' }),
    'C_LIST_SOURCE_BOUNDARY_05': indexSession,
    'C_PROVIDER_CHATGPT_TREE_02': listSession,
    'C_PROVIDER_CHATGPT_TREE_04': listSession,
    'C_PROVIDER_CHATGPT_TREE_06': listSession,
    'C_PROVIDER_CHATGPT_TREE_09': listSession,
    'C_E2E_CHATGPT_SCAN_02': () => ({
        accessToken: 'test-token', user: { id: 'chatgpt-user', name: 'GPT test account' },
        account: { id: 'workspace' },
    }),
    'C_CAPTURE_SESSION_01': () => ({
        user: { id: 'subject' }, account: { id: 'workspace' }, accessToken: 'must-never-cross-worlds',
    }),
    'C_CAPTURE_SESSION_02': () => ({
        user: { id: 'other' }, account: { id: 'workspace' }, accessToken: 'must-never-cross-worlds',
    }),
    'C_CAPTURE_SESSION_03': () => ({
        user: { id: 'subject' }, account: { id: 'workspace' }, accessToken: 'must-never-cross-worlds',
    }),
    'C_FILE_DOWNLOAD_SESSION_01': () => ({ accessToken: 'tok' }),
    'C_CAPTURE_SESSION_04': () => ({
        user: { id: 'subject' }, account: { id: 'workspace' }, accessToken: 'must-never-cross-worlds',
    }),
    'C_CAPTURE_SESSION_05': () => ({
        user: { id: 'other' }, account: { id: 'workspace' }, accessToken: 'must-never-cross-worlds',
    }),
};
export function sessionGen(key: keyof typeof fixtureMap): Record<string, unknown> {
    return fixtureMap[key]();
}

export const fixtureOrigins = describeFixtures(fixtureMap, synthetic("Authored ChatGPT protocol, content or state counterexample; no saved capture is used."));
