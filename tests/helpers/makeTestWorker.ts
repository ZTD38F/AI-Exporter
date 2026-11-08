import type { AIProvider } from '../../src/l1/client/aiProvider.js';

// Application / Export depends on the L1 AIProvider port, not the deleted v1
// BatchWorker. A successful v2 Detail refresh returns void: the mocked L1
// callback must perform any required L2 admission before it resolves.
export function makeTestExportProvider(overrides: Partial<AIProvider> = {}): AIProvider {
    return {
        id: 'gemini',
        name: 'Mock Gemini Provider',
        hostPatterns: [],
        async checkReadiness() { return { ready: true }; },
        async listConversations() { return 'source_end'; },
        async fetchConversationDetail() {
            throw new Error('Mock L1 fetchConversationDetail must be supplied by the test');
        },
        async acquireResource() {
            throw new Error('Mock L1 acquireResource must be supplied by the test');
        },
        matchesUrl() { return false; },
        ...overrides,
    };
}

const v2ProviderFields = new Set<keyof AIProvider>([
    'id', 'name', 'hostPatterns', 'checkReadiness', 'listConversations',
    'fetchConversationDetail', 'acquireResource', 'matchesUrl',
]);

/**
 * @deprecated Only retained as a named import while remaining v1 test callers
 * are migrated. This returns a v2 AIProvider, NOT a BatchWorker, and does not
 * accept v1 fetchChatDetail / parser-result contracts.
 * New tests should call makeTestExportProvider directly.
 */
export function makeTestWorker(overrides: object = {}): AIProvider {
    const unsupported = Object.keys(overrides).filter(
        field => !v2ProviderFields.has(field as keyof AIProvider),
    );
    if (unsupported.length) {
        throw new TypeError(
            'Unsupported v1 BatchWorker overrides: ' + unsupported.join(', ') +
            '; migrate to the v2 AIProvider contract',
        );
    }
    return makeTestExportProvider(overrides as Partial<AIProvider>);
}
