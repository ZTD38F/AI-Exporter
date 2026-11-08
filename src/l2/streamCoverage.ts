import type { PageObservation, PageObservationEvidence } from './pageObservation.js';
export interface CoverageKey { id: string; time: number }
export interface CoverageRange { head: CoverageKey; tail: CoverageKey }
export interface StreamCoverage { range: CoverageRange | null }
export const emptyStream = (): StreamCoverage => ({ range: null });
const overlaps = (a: CoverageRange, b: CoverageRange) => a.tail.time <= b.head.time && b.tail.time <= a.head.time;
const samePage = (a: PageObservationEvidence, b: PageObservationEvidence) =>
    a.providerId === b.providerId && a.accountId === b.accountId && a.streamId === b.streamId
    && a.requestedAt === b.requestedAt && a.nextCursor === b.nextCursor && a.ordered === b.ordered
    && a.requestKnown === b.requestKnown && a.valid === b.valid && a.terminal === b.terminal
    && a.keys.length === b.keys.length
    && a.keys.every((key, i) => key.id === b.keys[i].id && key.time === b.keys[i].time);

/** Ephemeral cursor evidence. Only a verified terminal chain establishes a new durable range. */
export class CoverageSession {
    // Persist only cursor evidence; source rows belong to ingestion, not Coverage.
    private pages = new Map<string | null, PageObservationEvidence>();
    private conflicts = new Set<string | null>();
    fork(): CoverageSession {
        const copy = new CoverageSession();
        copy.pages = new Map(this.pages); copy.conflicts = new Set(this.conflicts);
        return copy;
    }
    observe(previous: StreamCoverage, page: PageObservation): StreamCoverage {
        const prior = this.pages.get(page.requestCursor);
        if (page.requestCursor === null && (this.conflicts.has(null) || prior && !samePage(prior, page))) {
            if (prior && page.requestedAt < prior.requestedAt) return previous;
            this.pages.clear(); this.conflicts.clear();
        }
        if (!page.requestKnown || !page.valid || !page.ordered || !Number.isSafeInteger(page.requestedAt)
            || page.nextCursor !== null && page.nextCursor === page.requestCursor) {
            this.conflicts.add(page.requestCursor); this.pages.delete(page.requestCursor); return previous;
        }
        if (prior && page.requestCursor !== null && !samePage(prior, page)) {
            this.conflicts.add(page.requestCursor); this.pages.delete(page.requestCursor); return previous;
        }
        if (this.conflicts.has(page.requestCursor)) return previous;
        const { providerId, accountId, streamId, requestCursor, nextCursor, requestedAt, requestKnown, valid, ordered, terminal, keys } = page;
        this.pages.set(page.requestCursor, { providerId, accountId, streamId, requestCursor, nextCursor, requestedAt, requestKnown, valid, ordered, ...(terminal !== undefined ? { terminal } : {}), keys });
        if (this.pages.size > 2000) this.pages.delete(this.pages.keys().next().value ?? null);
        const chain = this.chain();
        return chain.terminal ? { range: chain.range } : previous;
    }
    exhausted(): boolean { return this.chain().terminal; }
    connects(previous: StreamCoverage, head: PageObservationEvidence): boolean {
        const anchor = this.pages.get(null);
        const chain = this.chain();
        return !!previous.range && head.requestCursor === null && !!anchor
            && samePage(anchor, { ...head, providerId: anchor.providerId })
            && !!chain.range && overlaps(previous.range, chain.range);
    }
    extend(previous: StreamCoverage): StreamCoverage {
        const range = this.chain().range;
        if (!previous.range || !range) return previous;
        return { range: { head: range.head.time >= previous.range.head.time ? range.head : previous.range.head,
            tail: range.tail.time <= previous.range.tail.time ? range.tail : previous.range.tail } };
    }
    private chain(): { range: CoverageRange | null; terminal: boolean } {
        let page = this.pages.get(null);
        const anchor = page;
        const visited = new Set<string | null>(), ids = new Set<string>();
        const keys: CoverageKey[] = [];
        let lastTime = Infinity, lastRequestedAt = -Infinity;
        while (page && anchor) {
            if (visited.has(page.requestCursor) || this.conflicts.has(page.requestCursor) || !page.requestKnown || !page.valid || !page.ordered
                || page.providerId !== anchor.providerId || page.accountId !== anchor.accountId || page.streamId !== anchor.streamId
                || page.requestedAt < lastRequestedAt
                || page.keys.some(k => !k.id || !Number.isSafeInteger(k.time) || ids.has(k.id) || k.time > lastTime)
                || new Set(page.keys.map(k => k.id)).size !== page.keys.length) break;
            visited.add(page.requestCursor);
            for (const key of page.keys) { ids.add(key.id); keys.push(key); }
            if (page.keys.length) lastTime = page.keys[page.keys.length - 1].time;
            lastRequestedAt = page.requestedAt;
            if (page.nextCursor === null) return { range: keys.length ? { head: keys[0], tail: keys[keys.length - 1] } : null, terminal: true };
            page = this.pages.get(page.nextCursor);
        }
        return { range: keys.length ? { head: keys[0], tail: keys[keys.length - 1] } : null, terminal: false };
    }
}
