import type { Account } from '../../../../l2/accountRegistry.js';
import { createProcessSessionHandler } from './processSession.js';
import { batchexecuteHandler } from './batchexecute.js';
import { createStreamGenerateHandler } from './streamGenerate.js';

/** Captured once at send time, before the page can switch accounts or routes. */
export interface GeminiCaptureContext {
    url: string;
    slot: string;
    pagePath: string;
    requestedAt: number;
    requestAccountObservation: Omit<Account, 'id'> | null;
}

export interface GeminiResponseHandler {
    captureLimit: number;
    start(body: string): void;
    progress?(chunk: string): void;
    complete(body: string, text: string, truncated: boolean, successful: boolean): void;
    end(): void;
}

/** Transport selection only; endpoint handlers own their response semantics. */
export function createGeminiResponseRouter() {
    const streamGenerateHandler = createStreamGenerateHandler();
    const processSessionHandler = createProcessSessionHandler();
    return (sourceUrl: string) => {
        let url: URL;
        try { url = new URL(sourceUrl); } catch { return null; }
        if (url.protocol === 'https:' && url.hostname === 'geminiweb-pa.clients6.google.com'
            && url.pathname === '/v1/processSession') return processSessionHandler;
        if (url.protocol !== 'https:' || !['gemini.google.com', 'bard.google.com'].includes(url.hostname)) return null;
        if (url.pathname.endsWith('/batchexecute')) return batchexecuteHandler;
        if (url.hostname === 'gemini.google.com' && url.pathname.endsWith('/StreamGenerate')) return streamGenerateHandler;
        return null;
    };
}
