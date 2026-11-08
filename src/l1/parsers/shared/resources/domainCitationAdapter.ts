import type { DomainCitation, DomainMessage } from '../../../../l2/conversationDetail.js';
import { linkCitationMarkers } from './citationAdapter.js';

/** Resolve raw textual markers before returning Domain, never inside a composer/backend. */
export function closeSourceCitations(message: DomainMessage, markers?: readonly string[]): DomainMessage {
    const web = (message.citations ?? []).map(citation => ({ ...citation }));
    const citations: DomainCitation[] = [...web];
    const grounding = new Map<string, { citation: { id: string }; displayLabel: string }[]>();
    for (const raw of markers ?? []) {
        const marker = raw.trim();
        // A combined marker such as [cite:1,2] names one citation per number,
        // in order; duplicates within the marker collapse to a single entry.
        const numbers = [...new Set([...marker.matchAll(/\d+/g)].map(match => Number(match[0])))];
        if (!numbers.length || numbers.some(number => !Number.isSafeInteger(number))) continue;
        const entries = numbers.map(number => {
            const id = `grounding-${number}`;
            if (!citations.some(citation => citation.id === id)) citations.push({ id });
            return { citation: { id }, displayLabel: `[${number}]` };
        });
        grounding.set(marker, entries);
        grounding.set(marker.toLowerCase().replace(/\s+/g, ' '), entries);
    }
    linkCitationMarkers(message.content, web, grounding);
    if (message.reasoning) linkCitationMarkers(message.reasoning, web, grounding);
    return { ...message, ...(citations.length ? { citations } : {}) };
}
