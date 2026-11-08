import { isAccountId } from './accountRegistry.js';
import type { PageObservation, PageObservationEvidence, PageObservationHead } from './pageObservation.js';
import { CoverageSession, emptyStream, type StreamCoverage } from './streamCoverage.js';
import { indexCoverageSession, commitIndexCoverageSession } from './indexCoverage.js';
import { getCoverage, updateCoverageAtomically } from '../l3a/storageService.js';
export { getCoverage } from '../l3a/storageService.js';
export type ScanHead = PageObservationHead;

/** Evaluate source evidence under Storage's current Coverage, publishing the cursor chain after commit. */
export async function recordPageCoverage(accountId: string, page: PageObservation, canCommit?: () => boolean): Promise<void> {
    if (!isAccountId(accountId) || page.accountId !== accountId) throw new TypeError('Coverage requires its Registry UUID');
    let accepted: CoverageSession | undefined;
    await updateCoverageAtomically(accountId, page.streamId, current => {
        if (canCommit?.() === false) throw new Error('Page was cancelled before coverage admission');
        // A cleared row invalidates all earlier in-memory cursor evidence, even in this Context.
        accepted = current === null ? new CoverageSession() : indexCoverageSession(accountId, page.streamId).fork();
        const previous = current ?? emptyStream();
        const next = accepted.observe(previous, page);
        return { ...(current === null || next !== previous ? { next } : {}), result: undefined };
    });
    if (accepted) commitIndexCoverageSession(accountId, page.streamId, accepted);
}
export async function hasTrustedBoundary(accountId: string, frozenBaseline: StreamCoverage, scanHead: ScanHead): Promise<boolean> {
    if (!frozenBaseline.range) return false;
    const head: PageObservationEvidence = { ...scanHead, providerId: '', accountId };
    return updateCoverageAtomically(accountId, scanHead.streamId, current => {
        // A user clear must not resurrect a frozen pre-clear baseline.
        if (!current?.range) return { result: false };
        const session = indexCoverageSession(accountId, scanHead.streamId);
        // Both the frozen baseline and the latest committed range must still connect.
        // A different terminal scan may have replaced the old boundary meanwhile.
        if (!session.connects(frozenBaseline, head) || !session.connects(current, head)) return { result: false };
        const next = session.extend(current);
        return { ...(JSON.stringify(next) !== JSON.stringify(current) ? { next } : {}), result: true };
    });
}
const CoverageAdmission = { getCoverage, recordPageCoverage, hasTrustedBoundary };
export default CoverageAdmission;
