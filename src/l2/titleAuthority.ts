export const TITLE_AUTHORITY_RANK = { user: 3, provider: 2, derived: 1 };
export type TitleSource = keyof typeof TITLE_AUTHORITY_RANK;
export interface TitleCandidate { value: string; source: TitleSource; observedAt?: string }
export function isTitleSource(source: string): source is TitleSource { return Object.hasOwn(TITLE_AUTHORITY_RANK, source); }
export function titleAuthorityRank(source: string | null | undefined): number { return source && isTitleSource(source) ? TITLE_AUTHORITY_RANK[source] : 0; }
export function resolveTitle(candidates: TitleCandidate[]): TitleCandidate | undefined {
    let winner: TitleCandidate | undefined;
    for (const item of candidates) if (item.value?.trim() && (!winner || TITLE_AUTHORITY_RANK[item.source] >= TITLE_AUTHORITY_RANK[winner.source])) winner = item;
    return winner;
}
