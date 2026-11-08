import type { ContentQuality } from '../../l2/quality.js';
export type { ContentQuality } from '../../l2/quality.js';
export interface QualityEvidence {
    rejectedTurns?: number;
    truncation?: string;
    heuristicDocumentIds?: string[];
}

/** Known content loss or uncertain reconstruction makes the body partial. */
export function contentQuality(facts: ContentQuality & QualityEvidence): ContentQuality {
    return { ...(facts.sourceTurn ? { sourceTurn: facts.sourceTurn } : {}), status: (facts.rejectedTurns ?? 0) > 0 || facts.truncation || facts.heuristicDocumentIds?.length ? 'partial' : facts.status };
}
