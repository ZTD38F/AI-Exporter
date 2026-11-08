import { copyDefinedField, type ResourceEvidence } from '../src/l1/parsers/shared/resources/resourceEvidence.js';
import type { DomainGeneratedMediaIdentity } from '../src/l2/conversationDetail.js';
import type { ResourceAcquisitionHint } from '../src/l1/resources/resourceAcquisition.js';
import type { SourceAttachmentInput } from '../src/l1/parsers/shared/resources/resolveResources.js';

function resourceMetadataContracts(record: ResourceEvidence, generation: DomainGeneratedMediaIdentity, hint: ResourceAcquisitionHint): void {
    copyDefinedField(generation, record.generation ?? {}, 'time');
    copyDefinedField(hint, record, 'imageOrdinal');
    // @ts-expect-error Field values must match the selected destination field.
    copyDefinedField(generation, { time: '1700000000' }, 'time');
    // @ts-expect-error Generation metadata cannot acquire source-only identities.
    copyDefinedField(generation, { chatId: 'source' }, 'chatId');
    // @ts-expect-error Acquisition ordinals remain numbers through projection.
    copyDefinedField(hint, { imageOrdinal: '0' }, 'imageOrdinal');
    // @ts-expect-error Source token validation belongs to the source parser.
    const input: SourceAttachmentInput = { token: 7 };
    void input;
}
void resourceMetadataContracts;
