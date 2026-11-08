import { renderList } from '../src/ui/options/views/listView.js';
import { ConversationViewState } from '../src/ui/options/state/conversationsStore.js';
import { indexActivityTime } from '../src/l2/conversationIndex.js';
import type { ReadonlyDomain } from '../src/l2/runtimeValidation.js';

function checkConsumers(input: ReadonlyDomain, state: ConversationViewState) {
    const indexes: ConversationViewState['indexes'] = [input.index];
    state.indexes = indexes;
    renderList(state, false);
    indexActivityTime(input.index);
    // v2 ReadonlyDomain is shallow. Downstream renders use an explicitly readonly Index view.
    const readonlyIndex: Readonly<typeof input.index> = input.index;
    // @ts-expect-error Render-facing Index facts are immutable in their readonly projection.
    readonlyIndex.title = 'changed';
    // @ts-expect-error Source timestamps remain numeric.
    indexActivityTime({ updatedAt: 'not-a-number' });
    // @ts-expect-error Primitive inputs cannot be used as conversation indexes.
    indexActivityTime(123);
    // @ts-expect-error Historical aliases do not belong in canonical index consumers.
    indexActivityTime({ timestamp: 123 });
    // @ts-expect-error Readonly Index projections cannot rewrite activity time.
    readonlyIndex.updatedAt = 123;
    const key = state.keys()[0];
    // @ts-expect-error Selection returns scoped keys, never editable Domain records.
    key.title = 'changed';
    const record = state.records[key.conversationId];
    // @ts-expect-error Export source versions remain numeric.
    record.chatTime = 'invalid';
}
void checkConsumers;
