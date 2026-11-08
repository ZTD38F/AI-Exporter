import type { DomainConversationIndex } from '../../l2/conversationIndex.js';
import type { DomainConversationDetail } from '../../l2/conversationDetail.js';
import type { Diagnostic } from '../../shared/diagnostics/diagnostic.js';
import type { QualityEvidence } from './qualityEvidence.js';
import type { ResourceAcquisitionHints } from '../resources/resourceAcquisition.js';

/** The only L1 Parser output contract. L2 binds keys and validates Domain. */
export interface SourceConversationParseResult {
    conversationId: string;
    conversation: {
        index: Omit<DomainConversationIndex, 'key'>;
        detail: Omit<DomainConversationDetail, 'key'>;
    };
    /** Source activity version captured with this body (epoch ms), never a local write clock. */
    sourceVersion?: number;
    evidence?: QualityEvidence;
    diagnostics: Diagnostic[];
    acquisitionHints: ResourceAcquisitionHints;
}
