import { fixtureKey } from './helpers/domainFixture.js';
import type { HistoricalConversation as Conversation } from './helpers/historicalConversation.js';
import type { DomainAsset, DomainMessage, DomainMessageRole } from '../src/l2/conversationDetail.js';
import type { DomainConversationWithDetail } from '../src/l2/conversation.js';
import { historicalFixtureDomain } from './helpers/nativeFixture.js';

const legacyConversation: Conversation = {
    id: 'typed-conversation',
    title: 'Typed fixture',
    timestamp: null,
    messages: [{ role: 'assistant', content: 'Typed message', timestamp: null }],
};

const domainConversation: DomainConversationWithDetail = historicalFixtureDomain(legacyConversation);

// These assignments make both adapter boundaries part of strict TypeScript checking.
const acceptedLegacyInput: Conversation = legacyConversation;
const typedDomainResult: DomainConversationWithDetail = domainConversation;
void acceptedLegacyInput;
void typedDomainResult;

import type { BlockNode } from '../src/l2/content/blocks.js';
const body = (text: string): BlockNode[] => text ? [{ type: 'paragraph', children: [{ type: 'text', text }] }] : [];

// The Domain boundary accepts provider-neutral roles only.
const domainRoles: DomainMessageRole[] = ['user', 'assistant', 'system'];
const domainMessage: DomainMessage = { role: 'assistant', content: body('Answer') };
// @ts-expect-error Gemini's model role must not cross the Domain boundary.
const rejectedDomainRole: DomainMessageRole = 'model';
// @ts-expect-error DomainMessage must use DomainMessageRole.
const rejectedDomainMessage: DomainMessage = { role: 'model', content: body('Answer') };
void domainRoles;
void domainMessage;
void rejectedDomainRole;
void rejectedDomainMessage;

const timestampedDomainMessage: DomainMessage = { role: 'user', content: body('Question'), timestamp: 1700000000123 };
// @ts-expect-error Unknown Domain message timestamps must be absent, never null.
const rejectedNullTimestamp: DomainMessage = { role: 'assistant', content: body('Answer'), timestamp: null };
void timestampedDomainMessage;
void rejectedNullTimestamp;

// @ts-expect-error Raw role provenance is not a Domain field.
const provenanceDomainMessage: DomainMessage = { role: 'assistant', content: body('x'), provenance: { rawRole: 'custom' } };
// @ts-expect-error Raw Gemini turn metadata is not part of DomainMessage.
const rejectedTurnId: DomainMessage = { role: 'assistant', content: body('x'), turnId: 'raw-turn' };
// @ts-expect-error Provider request identity belongs on generated resources, never directly on messages.
const rejectedTopLevelRequestId: DomainMessage = { role: 'assistant', content: body('x'), providerRequestId: 'abcd1234' };
void provenanceDomainMessage;
void rejectedTurnId;
void rejectedTopLevelRequestId;

// @ts-expect-error Legacy resource generation identity is not a message generation event.
const rejectedMessageGeneration: DomainMessage = { role: 'assistant', content: body('x'), generation: { chatId: 'chat', generationOrdinal: 0 } };
void rejectedMessageGeneration;

const normalizedAliases: DomainMessage = {
    role: 'assistant', content: body('Answer'), reasoning: body('Provider reasoning'),
    citations: [{ id: 'source', url: 'https://example.com', title: 'Example' }],
};
// @ts-expect-error Legacy thoughts must not cross the Domain boundary.
const rejectedThoughts: DomainMessage = { role: 'assistant', content: body(''), thoughts: 'Legacy' };
// @ts-expect-error Legacy thinking must not cross the Domain boundary.
const rejectedThinking: DomainMessage = { role: 'assistant', content: body(''), thinking: 'Legacy' };
// @ts-expect-error Raw sources must not cross the Domain boundary.
const rejectedSources: DomainMessage = { role: 'assistant', content: body(''), sources: ['https://example.com'] };
// @ts-expect-error Domain reasoning must contain Content AST nodes.
const rejectedReasoningArray: DomainMessage = { role: 'assistant', content: body(''), reasoning: ['Legacy'] };
void normalizedAliases;
void rejectedThoughts;
void rejectedThinking;
void rejectedSources;
void rejectedReasoningArray;

// @ts-expect-error Raw Markdown is not a Domain body.
const rejectedRawBody: DomainMessage = { role: 'assistant', content: '**raw**' };
// @ts-expect-error Raw provider structure must be consumed before Domain.
const rejectedRawStructure: DomainMessage = { role: 'assistant', content: [], structuredContent: {} };
// @ts-expect-error C2's transitional body alias is gone.
const rejectedBodyAlias: DomainMessage = { role: 'assistant', content: [], contentAst: [] };
void rejectedRawBody;
void rejectedRawStructure;
void rejectedBodyAlias;

// @ts-expect-error Legacy image aliases are resolved before Domain construction.
const rejectedImageAlias: DomainMessage = { role: 'assistant', content: [], images: [] };
// @ts-expect-error Document metadata belongs to a resource, not a separate message list.
const rejectedDocumentAlias: DomainMessage = { role: 'assistant', content: [], documents: [] };
// @ts-expect-error Mutable acquisition byte views are converted to serializable payloads.
const rejectedByteView: DomainAsset = { id: 'asset', kind: 'file', dataBuffer: new Uint8Array([1]) };
void rejectedImageAlias;
void rejectedDocumentAlias;
void rejectedByteView;

// @ts-expect-error Resources belong in the conversation registry, never inline on messages.
const rejectedMessageAttachments: DomainMessage = { role: 'assistant', content: [], attachments: [] };
// @ts-expect-error Raw reasoning strings must be parsed before Domain.
const rejectedRawReasoning: DomainMessage = { role: 'assistant', content: [], reasoning: 'raw' };
// @ts-expect-error Export destinations belong to the export layer.
const rejectedExportPath: DomainAsset = { id: 'asset', kind: 'image', subDir: 'images' };
// @ts-expect-error Export availability/layout fields are not Domain metadata.
const rejectedExportStatus: DomainAsset = { id: 'asset', kind: 'file', status: 'available' };
// @ts-expect-error Domain conversation requires explicit provider identity.
const rejectedMissingProvider: DomainConversationWithDetail = { id: 'chat', title: '', timestamp: null, assets: [], messages: [] };
// @ts-expect-error Domain conversation requires its resource registry, including when empty.
const rejectedMissingAssets: DomainConversationWithDetail = { id: 'chat', title: '', timestamp: null, providerId: 'provider', messages: [] };
void rejectedMessageAttachments;
void rejectedRawReasoning;
void rejectedExportPath;
void rejectedExportStatus;
void rejectedMissingProvider;
void rejectedMissingAssets;

// @ts-expect-error Message generation events are diagnostics, not durable body facts.
const generationEvent: DomainMessage = { role: 'assistant', content: body(''), generation: { mediaKind: 'image', outputCount: 2 } };
void generationEvent;

// Normalized resource consumers cannot widen their time contract for a legacy producer.
import type { ResourceEvidence } from '../src/l1/parsers/shared/resources/resourceEvidence.js';
import type { ResourceAcquisitionHint } from '../src/l1/resources/resourceAcquisition.js';
import type { DomainAsset as TakeoutResourceLookup } from '../src/l2/conversationDetail.js';
// @ts-expect-error Resolved evidence has already crossed the source normalization boundary.
const nullResourceEvidence: ResourceEvidence = { type: 'file', createdAt: null };
// @ts-expect-error Acquisition hints carry normalized identity rather than legacy media metadata.
const nullAcquisitionHint: ResourceAcquisitionHint = { generation: { generationOrdinal: 0, time: null } };
// @ts-expect-error Domain resource lookups cannot inherit nullable times from the old media map.
const nullTakeoutLookup: TakeoutResourceLookup = { id: 'x', kind: 'image', generation: { time: null } };
void nullResourceEvidence;
void nullAcquisitionHint;
void nullTakeoutLookup;

// @ts-expect-error Acquisition failures belong to ResourceResult, never Domain.
const failedAsset: DomainAsset = { id: 'image', kind: 'image', failureReason: 'HTTP 404' };
// @ts-expect-error Citation numbering belongs to Document composition.
const numberedCitation: import('../src/l2/conversationDetail.js').DomainCitation = { id: 'cite', number: 1 };
// @ts-expect-error Unknown title sources must be normalized before Domain.
const unknownTitleSource: DomainConversationWithDetail = { index: { ...domainConversation.index, titleSource: 'unknown-source' }, detail: { key: domainConversation.index.key,  ...domainConversation.detail } };
void failedAsset; void numberedCitation; void unknownTitleSource;

// @ts-expect-error Conversation activity belongs solely to Index.
const duplicateActivity: DomainConversationWithDetail = { index: { ...domainConversation.index }, detail: { key: domainConversation.index.key,  ...domainConversation.detail, updatedAt: 1700000000000 } };
// @ts-expect-error The saved body version belongs to its storage envelope.
const embeddedSavedVersion: DomainConversationWithDetail = { index: { ...domainConversation.index }, detail: { key: domainConversation.index.key,  ...domainConversation.detail }, savedAt: 1700000000000 };
// @ts-expect-error Acquisition context cannot become a persisted Detail field.
const embeddedCaptureVersion: DomainConversationWithDetail = { index: { ...domainConversation.index }, detail: { key: domainConversation.index.key,  ...domainConversation.detail }, sourceVersion: 1700000000000 };
void [duplicateActivity, embeddedSavedVersion, embeddedCaptureVersion];
