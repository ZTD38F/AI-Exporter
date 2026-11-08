import type { Citation } from './extractors.js';

/** Candidate-local source IDs; never search other candidates or turns for a match. */
export interface GeminiSourceAttribution {
    sourceId: string;
    sources: Citation[];
}

export function extractSourceAttributions(candidate: unknown): GeminiSourceAttribution[] {
    const metadata: unknown = Array.isArray(candidate) ? candidate[2] : undefined;
    const entries: unknown = Array.isArray(metadata) ? metadata[1] : undefined;
    if (!Array.isArray(entries)) return [];
    const byId = new Map<string, GeminiSourceAttribution>();
    const ambiguous = new Set<string>();
    for (const entry of entries) {
        if (!Array.isArray(entry) || typeof entry[3] !== 'string' || !/^spp_[\w-]+$/.test(entry[3])) continue;
        const sourceId: string = entry[3];
        if (!Array.isArray(entry[2]) || !entry[2].length) { ambiguous.add(sourceId); continue; }
        const sources: Citation[] = [];
        for (const source of entry[2]) {
            if (!Array.isArray(source) || typeof source[0] !== 'string' || !/^https?:\/\//.test(source[0])
                || typeof source[1] !== 'string') { ambiguous.add(sourceId); break; }
            if (!sources.some(item => item.url === source[0])) sources.push({ url: source[0], title: source[1] });
        }
        const attribution = { sourceId, sources };
        const existing = byId.get(sourceId);
        if (existing && JSON.stringify(existing.sources) !== JSON.stringify(sources)) ambiguous.add(sourceId);
        byId.set(sourceId, attribution);
    }
    return [...byId.values()].filter(entry => !ambiguous.has(entry.sourceId));
}
