import type { TestContext } from 'node:test';
import { indexStorage } from './indexStorage.js';
import { accountRuntime, ACCOUNT_OBSERVATION, ACCOUNT_UUID } from './accountRuntime.js';
import { resolveCurrentAccount } from '../../src/runtime/content/accountContext.js';
import { init, cleanup } from '../../src/runtime/content/liveSaveCoordinator.js';
import type { ExportResult } from '../../src/application/export/types.js';

export async function liveCoordinatorHost(t: TestContext) {
    const storage = indexStorage(), runtime = accountRuntime();
    await resolveCurrentAccount(ACCOUNT_OBSERVATION, 'u0');
    const forward = chrome.runtime.sendMessage.bind(chrome.runtime);
    const sent: unknown[] = [], feedback: ExportResult[] = [], errors: string[] = [];
    const result: ExportResult = { exported: 1, skipped: 0, partial: 0, failed: [], aborted: false };
    let reply: () => Promise<unknown> = async () => ({ ok: true, result });
    chrome.runtime.sendMessage = (async (message: { action: string }) => {
        if (message.action !== 'runLiveSave') return forward(message);
        sent.push(message); return reply();
    }) as typeof chrome.runtime.sendMessage;
    const badge = { showLiveSaveResult: (value: ExportResult | null) => { if (value) feedback.push(value); }, showLiveSaveError: (id: string) => { errors.push(id); } };
    init({ badge });
    t.after(() => { cleanup(); runtime.restore(); storage.restore(); });
    return { sent, feedback, errors, result, badge, runtime, reply: (next: () => Promise<unknown>) => { reply = next; },
        key: { accountId: ACCOUNT_UUID, conversationId: 'live123' } };
}
