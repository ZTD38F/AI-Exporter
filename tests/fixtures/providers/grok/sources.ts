import detail from '../grokDetail.json';
import imageDetail from '../grokImageDetail.json';

/** Captured metadata/tree/load-responses bodies; no production parser runs here. */
export function textDetail() {
    const copy: Omit<typeof detail, 'tree'> & { tree: {
        responseNodes: typeof detail.tree.responseNodes; inflightResponses: unknown[];
    } } = structuredClone(detail);
    return copy;
}

export const imageDetailBody = () => structuredClone(imageDetail);
export const metadataBody = () => structuredClone(detail.metadata);
export const responsesBody = () => structuredClone(detail.bodies);
export const conversationRow = () => structuredClone(detail.metadata.conversation);
export const conversationId = detail.id;
