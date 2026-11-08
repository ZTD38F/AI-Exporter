import { resolveAccountTab, getAITab, type AccountTab } from '../src/runtime/capabilities/tabService.js';
import { assertContentSender } from '../src/runtime/background/contentSender.js';

async function tabContracts(sender: chrome.runtime.MessageSender, rawTab: chrome.tabs.Tab): Promise<void> {
    const tabId: number = (await resolveAccountTab('account')).id;
    const aiTabId: number = (await getAITab('gemini', 'account')).id;
    const sourceId: number = assertContentSender(sender).tabId;
    // @ts-expect-error Chrome's optional ID is insufficient for a routed Account tab.
    const missingId: AccountTab = rawTab;
    // @ts-expect-error A routed Account tab cannot have an undefined ID.
    const absentId: AccountTab['id'] = undefined;
    // @ts-expect-error Sender validation must retain the concrete ID proof.
    const absentSender: ReturnType<typeof assertContentSender> = { providerId: 'gemini' };
    void [tabId, aiTabId, sourceId, missingId, absentId, absentSender];
}
void tabContracts;
