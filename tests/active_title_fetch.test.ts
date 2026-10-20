export {};
const test = require('node:test');
const assert = require('node:assert');
const { __setModuleOverride } = require('../src/core/utils/moduleOverrides.js');
const { scheduleActiveChatDetailFetch } = require('../src/content/syncEngine.js');
const { ProviderRegistry } = require('../src/core/provider/providerRegistry.js');

test('active detail fetch does not skip timestamped placeholder or sniff titles', async (t: any) => {
    const original = ProviderRegistry.getDefault();
    const fetched: string[] = [];
    ProviderRegistry.unregister('gemini');
    ProviderRegistry.register({ ...original, id: 'gemini', matchesUrl: () => true,
        fetchConversationDetail: async (id: string) => { fetched.push(id); return null; }
    });
    __setModuleOverride('StorageService', { getConversations: async () => [
        { id: 'generic_title_01', title: 'Gemini', titleSource: 'default', timestamp: 1700000000000 },
        { id: 'sniff_title_01', title: 'Initial question', titleSource: 'sniff', timestamp: 1700000000000 },
        { id: 'resolved_title_01', title: 'A resolved conversation title', titleSource: 'rpc', timestamp: 1700000000000 }
    ] });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
        for (const id of ['generic_title_01', 'sniff_title_01', 'resolved_title_01']) scheduleActiveChatDetailFetch(id);
        t.mock.timers.tick(200);
        for (let i = 0; i < 10; i++) await Promise.resolve();
        assert.deepStrictEqual(fetched.sort(), ['generic_title_01', 'sniff_title_01']);
    } finally {
        __setModuleOverride('StorageService', null);
        ProviderRegistry.unregister('gemini');
        if (original) ProviderRegistry.register(original);
        t.mock.timers.reset();
    }
});
