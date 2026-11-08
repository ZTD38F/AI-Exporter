import { fixtureAccountFor } from './helpers/domainFixture.js';
import type { DomainConversation, DomainConversationWithDetail } from '../src/l2/conversation.js';
import type { DomainMessage } from '../src/l2/conversationDetail.js';
import type { DomainConversationIndex } from '../src/l2/conversationIndex.js';
import type { DeepReadonly } from '../src/l2/readonly.js';
import type { ReadonlyDomain, TrustedDomain } from '../src/l2/runtimeValidation.js';
import { composeDomainDocument } from '../src/l3b/compose/composeDomainDocument.js';
import { serializeDomainJson } from '../src/l4/format/json/serializeDomainJson.js';
import { contentComposer } from '../src/l3b/compose/composeContent.js';

/**
 * The frozen L2 ReadonlyDomain contract intentionally uses shallow Readonly<>:
 * its job is to require a Detail for downstream consumers, not to introduce an
 * additional deep-frozen Domain DTO. Test only the immutability it actually promises.
 */
function consumerContract(input: Parameters<typeof composeDomainDocument>[0]) {
    // @ts-expect-error Consumers cannot replace the index member of the aggregate.
    input.index = { ...input.index };
    // @ts-expect-error Consumers cannot replace the detail member of the aggregate.
    input.detail = { ...input.detail };
    // @ts-expect-error Index-only conversations cannot be composed.
    composeDomainDocument({ index: input.index } satisfies DomainConversation, fixtureAccountFor(input));
    // @ts-expect-error JSON archives also require a present Detail.
    serializeDomainJson({ index: input.index } satisfies DomainConversation, fixtureAccountFor(input), {});
    // @ts-expect-error A readonly downstream view cannot claim L2's runtime trust brand.
    const verified: TrustedDomain = input;
    // @ts-expect-error Format JSON is not a legacy request wrapper.
    serializeDomainJson({ id: 'raw-request', conversation: input }, fixtureAccountFor(input), {});
    const jsonInput: Parameters<typeof serializeDomainJson>[0] = input;
    void [verified, jsonInput];
}

/** The content-composition port is explicitly deeply readonly, including nested AST. */
function contentContract(nodes: Parameters<ReturnType<typeof contentComposer>>[0]) {
    // @ts-expect-error A producer cannot add blocks through the L3b content port.
    nodes.push({ type: 'paragraph', children: [] });
    const node = nodes[0];
    if (node.type === 'paragraph') {
        // @ts-expect-error Read-only reaches nested block arrays.
        node.children.push({ type: 'text', text: 'changed' });
        if (node.children[0].type === 'text') {
            // @ts-expect-error Read-only reaches leaf values.
            node.children[0].text = 'changed';
        }
    }
}

/** A separately requested DeepReadonly view rejects nested mutations explicitly. */
function deepViewContract(view: DeepReadonly<DomainConversationWithDetail>) {
    // @ts-expect-error DeepReadonly prevents rewriting index metadata.
    view.index.title = 'changed';
    // @ts-expect-error DeepReadonly prevents editing message arrays.
    view.detail.messages.push({ role: 'assistant', content: [] });
    // @ts-expect-error DeepReadonly prevents editing message-owned references.
    view.detail.messages[0].attachmentIds?.push('missing');
    // @ts-expect-error DeepReadonly prevents changing nested generation evidence.
    view.detail.assets[0].generation!.prompt = 'changed';
    // @ts-expect-error DeepReadonly prevents editing source content nodes.
    view.detail.messages[0].content[0].type = 'math';
}

function schemaContract(input: ReadonlyDomain) {
    // @ts-expect-error Invalid provider role cannot masquerade as a v2 DomainMessage.
    const badRole: DomainMessage = { role: 'tool', content: [] };
    // @ts-expect-error Timestamps must be numeric in the L2 schema.
    const badTime: DomainConversationIndex = { key: input.index.key, updatedAt: 'today' };
    void [badRole, badTime];
}

function producerContract(builder: DomainConversationWithDetail, trusted: TrustedDomain) {
    builder.detail.messages.push({ role: 'assistant', content: [] });
    const view: ReadonlyDomain = trusted;
    composeDomainDocument(view, fixtureAccountFor(view));
    serializeDomainJson(view, fixtureAccountFor(view), {});
}
void [consumerContract, contentContract, deepViewContract, schemaContract, producerContract];
