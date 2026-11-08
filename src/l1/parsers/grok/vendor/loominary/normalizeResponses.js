// Adapted from Loominary src/grok.js, getConversation steps 3–4.
// Keep partial messages and source fields: the Domain adapter reports incompleteness.
export function normalizeGrokResponses(responseNodes, conversationData) {
const nodeMap = new Map();
                responseNodes.forEach(node => {
                    nodeMap.set(node.responseId, {
                        responseId: node.responseId,
                        parentResponseId: node.parentResponseId || null,
                        childResponseIds: node.childResponseIds || [],
                        threadId: node.threadId || null
                    });
                });

                // Step 4: Process and structure the data
                const processedResponses = (conversationData.responses || [])
                    .sort((a, b) => new Date(a.createTime) - new Date(b.createTime))
                    .map(r => {
                        const processed = {
                            ...r,
                            responseId: r.responseId,
                            sender: r.sender,
                            createTime: r.createTime,
                            message: r.message || ''
                        };

                        // Add tree structure information
                        const nodeInfo = nodeMap.get(r.responseId);
                        if (nodeInfo) {
                            processed.parentResponseId = nodeInfo.parentResponseId;
                            processed.childResponseIds = nodeInfo.childResponseIds;
                            if (nodeInfo.threadId) {
                                processed.threadId = nodeInfo.threadId;
                            }
                        }

                        // Process citations if present
                        if (r.sender === 'assistant' && r.cardAttachmentsJson && r.webSearchResults) {
                            const citations = [];
                            try {
                                r.cardAttachmentsJson.forEach(cardStr => {
                                    const card = JSON.parse(cardStr);
                                    if (card.cardType === 'citation_card' && card.url) {
                                        const searchResult = r.webSearchResults.find(sr => sr.url === card.url);
                                        citations.push({
                                            id: card.id,
                                            url: card.url,
                                            title: typeof searchResult?.title === 'string' && searchResult.title ? searchResult.title : 'Source'
                                        });
                                    }
                                });
                            } catch (e) {
                                console.warn('[Loominary] Failed to parse cardAttachmentsJson:', e);
                            }
                            if (citations.length > 0) {
                                processed.citations = citations;
                            }
                            if (r.webSearchResults) {
                                processed.webSearchResults = r.webSearchResults;
                            }
                        }

                        // Include other potentially useful fields
                        if (r.attachments) processed.attachments = r.attachments;
                        if (r.cardAttachmentsJson) processed.cardAttachmentsJson = r.cardAttachmentsJson;
                        if (r.imageAttachments) processed.imageAttachments = r.imageAttachments;
                        if (r.fileAttachments) processed.fileAttachments = r.fileAttachments;

                        return processed;
                    });


return processedResponses;
}
