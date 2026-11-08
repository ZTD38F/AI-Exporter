import type { ChatGPTApiConversationWithId } from './chatgptTypes.js';
import { parseChatGPTConversation } from './parseConversation.js';

export function parseOpenAIConversation(conversation: ChatGPTApiConversationWithId) {
    return parseChatGPTConversation({ conversation, assetsByNode: new Map(), source: 'archive' });
}
