import type { ReadonlyDomain } from '../../src/l2/runtimeValidation.js';
import { composeDomainDocument } from '../../src/l3b/compose/composeDomainDocument.js';
import { collectDocumentResources } from '../../src/l3b/ast/resourceReferences.js';
import { prepareExportResources } from '../../src/application/export/prepareExportResources.js';
import { fixtureAccountFor } from './domainFixture.js';

interface ReadingResourcesFixtureOptions {
    includeAssets?: boolean;
    acquire?: Parameters<typeof prepareExportResources>[2];
    signal?: AbortSignal;
}

/**
 * V2 fixture for the shared Markdown/HTML/PDF path:
 * trusted L2 Domain -> one L3b AST -> referenced Asset IDs -> Application resources.
 * It neither admits source facts nor adds a PDF-specific acquisition/cache pipeline.
 */
export async function prepareReadingResourcesFixture(
    conversation: ReadonlyDomain,
    options: ReadingResourcesFixtureOptions = {},
) {
    const document = composeDomainDocument(conversation, fixtureAccountFor(conversation));
    const references = collectDocumentResources(document);
    const resources = await prepareExportResources(
        conversation.detail.assets,
        options.includeAssets === false ? new Set<string>() : references.referencedIds,
        options.acquire ?? (async () => { throw new Error('Fixture requires an injected resource acquirer'); }),
        options.signal,
    );
    return { document, references, resources };
}
