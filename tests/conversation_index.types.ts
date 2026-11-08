import { fixtureKey } from './helpers/domainFixture.js';
import type { DomainConversationIndex, ConversationIndexPatch } from '../src/l2/conversationIndex.js';
import { putIndexes } from '../src/l3a/storageService.js';

const index: DomainConversationIndex = { key: fixtureKey(String('chat'), 'gemini'),   title: '', titleSource: "derived",
      };
const count: number | undefined = Reflect.get(index ?? {}, 'messageCount');
const source: DomainConversationIndex['titleSource'] = 'provider';
// @ts-expect-error Historical timestamp aliases never cross the index boundary.
const alias: DomainConversationIndex = { ...index, timestamp: 1 };
// @ts-expect-error Candidate maps are acquisition evidence, not canonical metadata.
const candidates: DomainConversationIndex = { ...index, titles: { rpc: 'Title' } };
// @ts-expect-error A body cannot enter index storage.
const body: DomainConversationIndex = { ...index, messages: [] };
// @ts-expect-error Unknown activity is absent, never null.
const undated: DomainConversationIndex = { ...index, updatedAt: null };
// @ts-expect-error Message observations do not create a second activity field.
const badMessageTime: DomainConversationIndex = { ...index, lastMessageAt: 10 };
// @ts-expect-error Identity cannot be changed by an index patch.
const patch: ConversationIndexPatch = { id: 'replacement' };
// @ts-expect-error Raw provider IDs require explicit UUID binding before storage.
const badWrite = () => putIndexes([{ id: 'chat', title: 'Title' }]);
void [badMessageTime, count, source, alias, candidates, body, undated, patch, badWrite];
