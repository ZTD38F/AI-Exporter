/** Persisted semantic quality. Parser evidence belongs beside the Domain snapshot. */
export type SourceTurnStatus = 'finished' | 'unfinished' | 'interrupted' | 'handoff' | 'awaiting_reply' | 'tool_pending' | 'unknown';
export interface ContentQuality {
    /** Coverage of the source snapshot, independent of whether generation has ended. */
    status: 'complete' | 'partial' | 'unknown';
    sourceTurn?: SourceTurnStatus;
}
