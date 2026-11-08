import { OperationError, operationError } from '../../shared/errors/operationError.js';
import { ResourceHttpError, ResourceProcessingError } from '../../shared/resources/resourceResult.js';
import type { DomainAsset } from '../../l2/conversationDetail.js';
import { readConversationKey, type ConversationKey } from '../../l2/conversationKey.js';
import type { SourceConversationParseResult } from '../parsers/parsingResult.js';
import type { ResourceBytes } from '../../shared/resources/resourceResult.js';
import { diagnosticOrigin, emitDiagnostic, type Diagnostic } from '../../shared/diagnostics/diagnostic.js';

type ResourceReader = (signal?: AbortSignal, onDiagnostic?: (diagnostic: Diagnostic) => void) => Promise<ResourceBytes>;
const conversationIdentity = (key: ConversationKey) => JSON.stringify([key.accountId, key.conversationId]);

/** The caller owns this context and releases it on completion. A workbench may
 * retain user-selected ZIP readers until pagehide; bytes never enter Domain. */
export function createSourceResourceContext() {
    const readers = new Map<string, Map<string, ResourceReader>>();
    let released = false;
    return {
        retain(key: ConversationKey, assetId: string, read: ResourceReader) {
            readConversationKey(key);
            if (released) throw new Error('Resource context released');
            const id = conversationIdentity(key);
            let conversationReaders = readers.get(id);
            if (!conversationReaders) {
                conversationReaders = new Map();
                readers.set(id, conversationReaders);
            }
            conversationReaders.set(assetId, read);
        },
        /** Called only after L2 accepts this entire Detail candidate. Replace, never
         * merge, previous readers: the same assetId may mean different bytes in a
         * later selected snapshot. ZIP-specific readers can be appended with retain(). */
        retainParsed(key: ConversationKey, parsed: SourceConversationParseResult) {
            readConversationKey(key);
            if (released) throw new Error('Resource context released');
            if (key.conversationId !== parsed.conversationId) throw new TypeError('Resource conversation mismatch');
            const selected = new Map<string, ResourceReader>();
            for (const asset of parsed.conversation.detail.assets) {
                const hint = parsed.acquisitionHints[asset.id];
                if (!hint) continue;
                const locator = [hint.url, hint.sourceUrl, hint.resolvedUrl, hint.src].find(uri => uri && /^(https:\/\/|data:)/i.test(uri));
                if (hint.dataBase64 !== undefined) {
                    const encoded = hint.dataBase64;
                    selected.set(asset.id, async () => {
                        const raw = encoded.startsWith('data:') ? encoded.slice(encoded.indexOf(',') + 1) : encoded;
                        const bytes = Uint8Array.from(atob(raw), character => character.charCodeAt(0));
                        return { bytes, mediaType: asset.mediaType ?? hint.mimeType ?? hint.mime };
                    });
                } else if (locator) selected.set(asset.id, (signal, onDiagnostic) => acquireSourceResource({ ...asset, sourceUri: locator }, signal, onDiagnostic));
            }
            readers.set(conversationIdentity(key), selected);
        },
        has(key: ConversationKey, assetId: string): boolean {
            return !released && readers.get(conversationIdentity(key))?.has(assetId) === true;
        },
        async acquire(key: ConversationKey, asset: DomainAsset, signal?: AbortSignal, remote?: ResourceReader,
            onDiagnostic?: (diagnostic: Diagnostic) => void): Promise<ResourceBytes> {
            readConversationKey(key);
            signal?.throwIfAborted();
            if (released) throw new Error('Resource context released');
            const read = readers.get(conversationIdentity(key))?.get(asset.id);
            let result: ResourceBytes | undefined;
            if (read) {
                try { result = await read(signal, onDiagnostic); }
                catch (error) {
                    signal?.throwIfAborted();
                    emitDiagnostic(onDiagnostic, { severity: 'info', code: 'RESOURCE_READER_FALLBACK',
                        message: 'Task reader failed; falling back to source acquisition',
                        details: { errorName: error instanceof Error ? error.name : 'NonError' } });
                }
            }
            signal?.throwIfAborted();
            if (!result?.bytes.byteLength) result = await (remote ? remote(signal, onDiagnostic) : acquireSourceResource(asset, signal, onDiagnostic));
            signal?.throwIfAborted();
            if (!result.bytes.byteLength) throw new ResourceProcessingError('Empty source resource');
            const mediaType = result.mediaType ?? asset.mediaType, name = result.name ?? asset.name;
            return { ...result, ...(mediaType ? { mediaType } : {}), ...(name ? { name } : {}) };
        },
        /** Folder exports discard already-delivered conversation readers immediately. */
        releaseConversation(key: ConversationKey) {
            readConversationKey(key);
            readers.delete(conversationIdentity(key));
        },
        release() { readers.clear(); released = true; },
    };
}
export type SourceResourceContext = ReturnType<typeof createSourceResourceContext>;

/** Bytes remain acquisition output, never a second Detail field. */
export async function acquireSourceResource(asset: DomainAsset, signal?: AbortSignal,
    onDiagnostic?: (diagnostic: Diagnostic) => void): Promise<ResourceBytes> {
    signal?.throwIfAborted();
    if (!asset.sourceUri || !/^(https:\/\/|data:)/i.test(asset.sourceUri)) throw new OperationError('RESOURCE_LOCATOR_UNAVAILABLE', 'No supported source locator');
    const startedAt = Date.now();
    const origin = diagnosticOrigin(asset.sourceUri);
    let phase = 'fetch';
    let credentials: RequestCredentials = 'include';
    let response: Response | undefined;
    try {
        try { response = await fetch(asset.sourceUri, { credentials, signal }); }
        catch (error) {
            signal?.throwIfAborted();
            if (!(error instanceof TypeError)) throw error;
            // Public images may allow wildcard CORS but reject credentialed reads.
            // Preserve authenticated downloads; retry only a transport failure.
            credentials = 'omit';
            emitDiagnostic(onDiagnostic, { severity: 'info', code: 'RESOURCE_CREDENTIAL_FALLBACK',
                message: 'Retrying source attachment without credentials', details: { origin } });
            response = await fetch(asset.sourceUri, { credentials, signal });
        }
        if (!response.ok) throw new ResourceHttpError(response.status);
        phase = 'read_body';
        const bytes = new Uint8Array(await response.arrayBuffer());
        signal?.throwIfAborted();
        if (!bytes.byteLength) throw new ResourceProcessingError('Empty source resource');
        const mediaType = asset.mediaType ?? response.headers.get('content-type')?.split(';')[0].trim();
        emitDiagnostic(onDiagnostic, { severity: 'info', code: 'RESOURCE_FETCH_COMPLETED', message: 'Source attachment bytes acquired',
            details: { origin, credentials, httpStatus: response.status, byteLength: bytes.byteLength, elapsedMs: Date.now() - startedAt } });
        return { bytes, ...(mediaType ? { mediaType } : {}), ...(asset.name ? { name: asset.name } : {}) };
    } catch (error) {
        emitDiagnostic(onDiagnostic, { severity: 'info', code: 'RESOURCE_FETCH_FAILED', message: 'Source attachment request failed',
            details: { phase, origin, credentials, httpStatus: response?.status ?? null,
                responseType: response?.type ?? null, redirected: response?.redirected ?? null,
                errorName: error instanceof Error ? error.name : 'NonError', aborted: signal?.aborted ?? false,
                elapsedMs: Date.now() - startedAt } });
        signal?.throwIfAborted();
        if (error instanceof TypeError) throw operationError(error, 'RESOURCE_DOWNLOAD_FAILED');
        throw error;
    }
}
