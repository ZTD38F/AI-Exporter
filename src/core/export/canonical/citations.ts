
export type CitationKind = 'web' | 'file' | 'attachment' | 'provider' | 'other';

export interface Citation {
    id: string;
    kind: CitationKind;

    url?: string;
    title?: string;
    publisher?: string;
    snippet?: string;
    assetId?: string;

}

export function citationDisplayLabel(
    citation: { title?: string; publisher?: string } | undefined,
    index: number,
    explicitLabel?: string,
): string {
    return explicitLabel ?? citation?.title ?? citation?.publisher ?? `[${index}]`;
}
